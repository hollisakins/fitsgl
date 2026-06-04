"""``fitsgl verify <url>`` — prove a deployed dataset satisfies the host contract.

The #1 deploy footgun is a host that silently ignores HTTP ``Range`` (the client
hard-rejects a ``200`` to a ranged request → a blank viewer, *late* and confusing).
This checker fetches a deployed dataset's own files and asserts the §2 contract
directly from response headers — and because it is a Python CLI, not a browser, it
reads every header without the CORS limits that constrain an in-page HUD, so it is
the authoritative HIT-vs-silent-origin-bypass probe (``docs/deploy-design.md`` §5.2).

Severity is tiered (DP7/§8): **correctness** checks (Range→``206``, MIME types,
``fitsgl.json`` loads, the CORS preflight) **fail** the command (non-zero exit); the
**perf** checks (cold-edge ``CF-Cache-Status``, per-object size vs the 512 MB edge
cap) only **warn** — a small dataset may legitimately not need the Cache Rule, and a
miss doesn't break the site. ``--strict`` promotes warnings to failures for CI.

The network I/O is isolated behind a small ``Fetch`` callable so the orchestration
unit-tests with a stub and integration-tests against a live ``fitsgl serve`` (the
reference implementation of the very contract checked here). It reuses
``manifest.Manifest`` to parse the fetched manifest, so it follows the supertile
``supertiles[]`` placement (and the v1 single-file shim) for free.
"""

from __future__ import annotations

import json
import posixpath
import re
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Callable

from .manifest import LevelInfo, Manifest

#: Cloudflare's max edge-cacheable object size on Free/Pro/Business (5 GB on
#: Enterprise). Mirrors ``build_pyramid.EDGE_CACHE_LIMIT_BYTES`` — defined here too
#: so this lightweight network tool need not import the astropy-heavy builder.
EDGE_CACHE_LIMIT_BYTES = 512 * 1024 * 1024

#: Check outcomes. PASS/SKIP never fail; FAIL always fails; WARN fails only under
#: ``--strict``.
PASS = "pass"
WARN = "warn"
FAIL = "fail"
SKIP = "skip"

#: Edge ``CF-Cache-Status`` values that mean the tile was edge-served (good).
_CACHED_STATUSES = frozenset({"HIT", "STALE", "UPDATING", "REVALIDATED"})

#: The §4.4 Cache Rule recipe, printed when a coarse tile is uncached.
_CACHE_RULE_HINT = (
    "tiles are not edge-cached — `.fits.fz` is NOT on Cloudflare's default "
    "cacheable-extension allowlist. Add ONE Cache Rule on the zone: match Hostname "
    "+ URI path ends with `.fits.fz` → 'Eligible for cache', Edge TTL 'respect "
    "origin' (see docs/deploy-design.md §4.4)."
)


@dataclass
class HttpResponse:
    """A fetched response: status, lower-cased headers, body (empty for HEAD)."""

    status: int
    headers: dict[str, str]
    body: bytes = b""

    def header(self, name: str) -> str | None:
        return self.headers.get(name.lower())


class FetchError(Exception):
    """A transport-level failure (connection refused, DNS, timeout) — *not* an
    HTTP error status, which is returned as an :class:`HttpResponse`."""


#: ``(method, url, headers) -> HttpResponse``. HTTP error *statuses* (4xx/5xx) come
#: back as a response; only transport failures raise :class:`FetchError`.
Fetch = Callable[[str, str, "dict[str, str] | None"], HttpResponse]

#: ``(name, status, detail[, kind]) -> None`` — records a check (closure over the
#: report); the perf-check helpers receive it so all results funnel through one path.
Record = Callable[..., None]


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Don't auto-follow 3xx — surface the redirect so verify can flag it.

    A custom-domain ``public_url`` that 301/302s to the managed ``r2.dev`` subdomain
    (which is *not* edge-cached, §9) would otherwise be followed silently and verify
    would happily check the uncacheable target. Returning ``None`` here makes urllib
    raise the 3xx as an ``HTTPError``, which the fetcher returns as a response.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D102
        return None


class UrllibFetcher:
    """The real :data:`Fetch`, stdlib-only (no third-party HTTP dep)."""

    def __init__(self, timeout: float = 15.0) -> None:
        self.timeout = timeout
        self._opener = urllib.request.build_opener(_NoRedirect())

    def __call__(self, method: str, url: str, headers: dict[str, str] | None = None) -> HttpResponse:
        req = urllib.request.Request(url, method=method, headers=headers or {})
        try:
            with self._opener.open(req, timeout=self.timeout) as resp:
                body = b"" if method == "HEAD" else resp.read()
                return HttpResponse(resp.status, _lower_headers(resp.headers.items()), body)
        except urllib.error.HTTPError as e:  # a real HTTP status (404/416, or an un-followed 3xx)
            body = b"" if method == "HEAD" else e.read()
            return HttpResponse(e.code, _lower_headers(e.headers.items()), body)
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise FetchError(f"{method} {url}: {e}") from e


def _lower_headers(items) -> dict[str, str]:
    """Header pairs → dict with lower-cased names (last wins)."""
    return {str(k).lower(): str(v) for k, v in items}


@dataclass
class CheckResult:
    """One verification check: a stable name, an outcome, and a human detail."""

    name: str
    status: str
    detail: str
    kind: str = "correctness"  # "correctness" (FAIL) | "perf" (WARN)


@dataclass
class VerifyReport:
    """The full result of verifying one base URL."""

    base_url: str
    checks: list[CheckResult] = field(default_factory=list)

    def add(self, name: str, status: str, detail: str, kind: str = "correctness") -> CheckResult:
        c = CheckResult(name=name, status=status, detail=detail, kind=kind)
        self.checks.append(c)
        return c

    @property
    def failures(self) -> list[CheckResult]:
        return [c for c in self.checks if c.status == FAIL]

    @property
    def warnings(self) -> list[CheckResult]:
        return [c for c in self.checks if c.status == WARN]

    def exit_code(self, *, strict: bool = False) -> int:
        """0 if no failures (and, under ``strict``, no warnings); else 1."""
        if self.failures:
            return 1
        if strict and self.warnings:
            return 1
        return 0

    def ok(self, *, strict: bool = False) -> bool:
        return self.exit_code(strict=strict) == 0


# ----------------------------------------------------------------- pure helpers


def _resolve(base_url: str, rel: str) -> str:
    """A dataset-relative POSIX path → absolute URL under ``base_url``."""
    return f"{base_url.rstrip('/')}/{rel.lstrip('/')}"


def _sibling(manifest_rel: str, filename: str) -> str:
    """A supertile ``filename`` resolved next to its band's ``manifest.json``."""
    return posixpath.join(posixpath.dirname(manifest_rel), filename)


def _levels_to_probe(manifest: Manifest) -> tuple[LevelInfo, LevelInfo]:
    """``(base_level, coarse_level)`` to sample: z=0 (largest, may exceed the cap)
    and the highest z (coarsest, smallest). Equal when there is a single level."""
    levels = sorted(manifest.levels, key=lambda lvl: lvl.z)
    base = levels[0]
    coarse = levels[-1]
    return base, coarse


# Anchor the extension at a path boundary so a `.json` (import-map / webmanifest)
# isn't truncated to a bogus `.js` — `\.m?js` matches .js/.mjs followed by a quote,
# bracket, whitespace, query/fragment, or end.
_JS_ASSET_RE = re.compile(
    r"""(?:src|href)\s*=\s*["']?\.?/?(assets/[^"'>\s]+\.m?js)(?=["'>\s?#]|$)""", re.IGNORECASE
)


def _first_js_asset(html: str) -> str | None:
    """The first ``assets/*.js`` (or ``.mjs``) path referenced by an ``index.html``."""
    m = _JS_ASSET_RE.search(html)
    return m.group(1) if m else None


def _mime_is_js(content_type: str | None) -> bool:
    """True if a Content-Type is a JavaScript MIME (an ES module won't load otherwise)."""
    if not content_type:
        return False
    base = content_type.split(";", 1)[0].strip().lower()
    return base in ("text/javascript", "application/javascript", "application/ecmascript", "text/ecmascript")


def _mime_is_octet(content_type: str | None) -> bool:
    if not content_type:
        return False
    return content_type.split(";", 1)[0].strip().lower() == "application/octet-stream"


def _content_length(resp: HttpResponse) -> int | None:
    raw = resp.header("content-length")
    if raw is None:
        return None
    try:
        return int(raw)
    except ValueError:
        return None


# ------------------------------------------------------------------ the checks


def verify_deployment(
    base_url: str,
    *,
    origin: str | None = None,
    fetch: Fetch | None = None,
    on_progress: Callable[[CheckResult], None] | None = None,
) -> VerifyReport:
    """Run the host-contract checks against a deployed dataset at ``base_url``.

    ``base_url`` is the dataset root (where ``fitsgl.json`` lives). ``origin``, if
    given, additionally asserts the cross-origin CORS preflight for an embedder at
    that site. ``fetch`` defaults to a real :class:`UrllibFetcher`; tests inject a
    stub. ``on_progress`` (if given) is called with each :class:`CheckResult` as it
    completes. Returns the :class:`VerifyReport`; the caller decides the exit code
    (so ``--strict`` lives in the CLI, not here).
    """
    fetch = fetch if fetch is not None else UrllibFetcher()
    report = VerifyReport(base_url=base_url.rstrip("/"))

    def record(name: str, status: str, detail: str, kind: str = "correctness") -> None:
        c = report.add(name, status, detail, kind)
        if on_progress is not None:
            on_progress(c)

    def try_fetch(name: str, method: str, url: str, headers: dict[str, str] | None = None) -> HttpResponse | None:
        try:
            return fetch(method, url, headers)
        except FetchError as e:
            record(name, FAIL, f"could not reach {url}: {e}")
            return None

    # 1. fitsgl.json loads + parses (prerequisite for everything else).
    cfg_url = _resolve(report.base_url, "fitsgl.json")
    resp = try_fetch("fitsgl.json loads", "GET", cfg_url)
    if resp is None:
        return report
    if resp.status != 200:
        detail = f"GET {cfg_url} returned {resp.status}, expected 200"
        if 300 <= resp.status < 400 and resp.header("location"):
            detail += (
                f" (redirects to {resp.header('location')}) — pass the final URL directly, and ensure it is "
                "the cached custom domain, not the uncached r2.dev subdomain"
            )
        record("fitsgl.json loads", FAIL, detail)
        return report
    try:
        config = json.loads(resp.body)
    except (ValueError, TypeError) as e:
        record("fitsgl.json loads", FAIL, f"{cfg_url} is not valid JSON: {e}")
        return report
    # Navigate defensively — a valid-JSON-but-wrong-shape config is exactly the
    # misconfig verify exists to flag *cleanly* (not crash on AttributeError/KeyError).
    ds = config.get("dataset") if isinstance(config, dict) else None
    bands = ds.get("bands") if isinstance(ds, dict) else None
    if not isinstance(bands, list) or not bands:
        record("fitsgl.json loads", FAIL, f"{cfg_url} has no dataset.bands array")
        return report
    record("fitsgl.json loads", PASS, f"{len(bands)} band(s)")

    # 2. The first band's manifest.json loads + parses.
    band = bands[0]
    tiles = band.get("tiles") if isinstance(band, dict) else None
    if not isinstance(tiles, list) or not tiles or not isinstance(tiles[0], str):
        record("manifest loads", FAIL, f"band {band!r} has no tiles[] manifest URL")
        return report
    manifest_rel = tiles[0]
    manifest_url = _resolve(report.base_url, manifest_rel)
    resp = try_fetch("manifest loads", "GET", manifest_url)
    if resp is None:
        return report
    if resp.status != 200:
        record("manifest loads", FAIL, f"GET {manifest_url} returned {resp.status}, expected 200")
        return report
    try:
        manifest = Manifest.from_dict(json.loads(resp.body))
    except (ValueError, TypeError, KeyError) as e:
        record("manifest loads", FAIL, f"{manifest_url} is not a valid manifest: {e}")
        return report
    if not manifest.levels:
        record("manifest loads", FAIL, f"{manifest_url} has no levels")
        return report
    if any(not lvl.supertiles for lvl in manifest.levels):
        # The builder always writes ≥1 supertile/level; an explicit empty list is a
        # corrupt/hand-edited manifest — flag it rather than IndexError on supertiles[0].
        record("manifest loads", FAIL, f"{manifest_url} has a level with no supertiles")
        return report
    record("manifest loads", PASS, f"band {band.get('name', '?')}, {len(manifest.levels)} level(s)")

    base_level, coarse_level = _levels_to_probe(manifest)
    tile_rel = _sibling(manifest_rel, base_level.supertiles[0].filename)
    tile_url = _resolve(report.base_url, tile_rel)

    # 3. Range → 206 (THE check). A 200 means the host ignored Range — the client
    #    hard-rejects it, so this is the single biggest deploy footgun.
    resp = try_fetch("Range → 206", "GET", tile_url, {"Range": "bytes=0-1023"})
    if resp is not None:
        if resp.status == 206 and resp.header("content-range"):
            record("Range → 206", PASS, f"{tile_rel} served {resp.header('content-range')}")
        elif resp.status == 206:
            record(
                "Range → 206",
                FAIL,
                f"{tile_rel} returned 206 but no Content-Range header — the response is malformed; "
                "the client needs the byte range echoed back.",
            )
        elif resp.status == 200:
            record(
                "Range → 206",
                FAIL,
                f"{tile_rel} returned 200 to a ranged request — the host ignores Range. "
                "The client hard-rejects this (blank viewer). The host MUST send 206.",
            )
        else:
            record("Range → 206", FAIL, f"{tile_rel} returned {resp.status} to a ranged request, expected 206")

    # 4. Tile MIME — application/octet-stream. text/* almost always means an error
    #    page or misconfig is being served in the tile's place.
    if resp is not None and resp.status in (200, 206):
        ct = resp.header("content-type")
        if _mime_is_octet(ct):
            record("tile MIME", PASS, f"{ct}")
        elif ct and ct.split(";", 1)[0].strip().lower().startswith("text/"):
            record("tile MIME", FAIL, f"{tile_rel} served as {ct!r}, expected application/octet-stream")
        else:
            record("tile MIME", WARN, f"{tile_rel} served as {ct!r} (expected application/octet-stream)", kind="perf")

    # 5. JS asset MIME — only if the viewer is deployed here (index.html present).
    #    An ES module is refused by the browser unless served with a JS MIME.
    idx_url = _resolve(report.base_url, "index.html")
    idx = try_fetch("JS asset MIME", "GET", idx_url)
    if idx is not None and idx.status == 200:
        asset_rel = _first_js_asset(idx.body.decode("utf-8", "replace"))
        if asset_rel is None:
            record("JS asset MIME", SKIP, "index.html references no assets/*.js")
        else:
            asset_url = _resolve(report.base_url, asset_rel)
            ar = try_fetch("JS asset MIME", "HEAD", asset_url)
            if ar is not None:
                ct = ar.header("content-type")
                if ar.status == 200 and _mime_is_js(ct):
                    record("JS asset MIME", PASS, f"{asset_rel} → {ct}")
                elif ar.status != 200:
                    record("JS asset MIME", FAIL, f"HEAD {asset_rel} returned {ar.status}")
                else:
                    record("JS asset MIME", FAIL, f"{asset_rel} served as {ct!r} — module scripts need a JS MIME")
    elif idx is not None:
        record("JS asset MIME", SKIP, "no index.html (data-only deploy — viewer hosted elsewhere)")

    # 6. CORS preflight — only when an embedding origin is given.
    if origin is not None:
        pre = try_fetch(
            "CORS preflight",
            "OPTIONS",
            tile_url,
            {"Origin": origin, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "range"},
        )
        if pre is not None:
            allow = pre.header("access-control-allow-origin")
            allow_headers = (pre.header("access-control-allow-headers") or "").lower()
            range_ok = "range" in allow_headers or "*" in allow_headers
            if allow != "*" and allow != origin:
                record(
                    "CORS preflight",
                    FAIL,
                    f"preflight from {origin!r} got Access-Control-Allow-Origin {allow!r} "
                    "(expected the origin or '*'); the embedder's ranged fetch will be blocked",
                )
            elif not range_ok:
                # Range is not a CORS-safelisted request header, so without it in
                # Allow-Headers the browser blocks the embedder's ranged GET — the
                # whole mechanism — even though Allow-Origin looks fine.
                record(
                    "CORS preflight",
                    FAIL,
                    f"preflight from {origin!r} does not allow the Range request header "
                    f"(Access-Control-Allow-Headers: {pre.header('access-control-allow-headers')!r}); "
                    "the embedder's ranged GET will be blocked",
                )
            else:
                record("CORS preflight", PASS, f"Allow-Origin: {allow}, Range permitted")

    # 7. Object-size + edge-cache (perf — warns). Probe the coarse level and z0;
    #    the z0 edge-cache diagnosis is gated on whether the coarse tile cached.
    samples = [("coarse", coarse_level)]
    if base_level is not coarse_level:  # single-level pyramid: probe just the one
        samples.append(("z0", base_level))
    coarse_cached: bool | None = None
    for label, level in samples:
        _check_object_sizes(report, fetch, report.base_url, manifest_rel, level, label, record)
        tile_url = _resolve(report.base_url, _sibling(manifest_rel, level.supertiles[0].filename))
        cached = _check_edge_cache(report, fetch, tile_url, label, coarse_cached, record)
        if label == "coarse":
            coarse_cached = cached

    return report


def _check_object_sizes(
    report: VerifyReport, fetch: Fetch, base_url: str, manifest_rel: str, level: LevelInfo, label: str, record: Record
) -> None:
    """HEAD *every* supertile of a level and warn if any exceeds the 512 MB cap.

    The chunker bounds supertiles by tile *count*, not bytes, and RICE size varies
    per sky region — so an over-cap block can hide at index>0 while ``supertiles[0]``
    reads under-cap. Aggregated into one PASS/WARN line. All outcomes are perf."""
    sizes: list[int] = []
    over: list[tuple[str, int]] = []
    for st in level.supertiles:
        path = _sibling(manifest_rel, st.filename)
        try:
            head = fetch("HEAD", _resolve(base_url, path), None)
        except FetchError:
            continue
        size = _content_length(head)
        if size is None:
            continue
        sizes.append(size)
        if size > EDGE_CACHE_LIMIT_BYTES:
            over.append((path, size))
    if not sizes:
        return  # couldn't measure any object — skip silently (perf, never fail)
    mib = 1024 * 1024
    if over:
        worst_path, worst_size = max(over, key=lambda t: t[1])
        record(
            f"object size ({label})",
            WARN,
            f"{len(over)} of {len(level.supertiles)} supertile(s) exceed the 512 MB edge cap "
            f"(largest {worst_path} = {worst_size / mib:.0f} MB) → origin-served, not edge-accelerated. "
            "Lower [build].supertile_blocks so each chunk stays under the cap (docs/supertile-design.md).",
            kind="perf",
        )
    else:
        record(
            f"object size ({label})",
            PASS,
            f"{len(sizes)} supertile(s), largest {max(sizes) / mib:.1f} MB (≤ 512 MB)",
            kind="perf",
        )


def _check_edge_cache(
    report: VerifyReport, fetch: Fetch, url: str, label: str, coarse_cached: bool | None, record: Record
) -> bool | None:
    """Warm the edge (one ranged GET) then read ``CF-Cache-Status`` on a second GET.

    Returns whether the tile was edge-served (True/False), or ``None`` when there is
    no CDN in front / the probe couldn't run. A z0 MISS is only blamed on the size
    cap when the coarse tile actually cached (``coarse_cached is True``); if coarse
    missed too, the cause is the missing §4.4 Cache Rule, reported on both lines."""
    rng = {"Range": "bytes=0-1023"}
    try:
        fetch("GET", url, rng)
        second = fetch("GET", url, rng)
    except FetchError:
        return None
    cf = second.header("cf-cache-status")
    if cf is None:
        record(f"edge cache ({label})", SKIP, "no CF-Cache-Status (origin not behind Cloudflare?)", kind="perf")
        return None
    if cf.upper() in _CACHED_STATUSES:
        record(f"edge cache ({label})", PASS, f"CF-Cache-Status: {cf}", kind="perf")
        return True
    if label == "z0" and coarse_cached is True:
        record(
            f"edge cache ({label})",
            WARN,
            f"CF-Cache-Status: {cf} on z0 — coarse levels are edge-cached but this object is not, so it "
            "likely exceeds the 512 MB cap; lower [build].supertile_blocks so it chunks under the limit.",
            kind="perf",
        )
    else:
        # coarse, or z0 when coarse also missed → the Cache Rule is the likely cause.
        record(f"edge cache ({label})", WARN, f"CF-Cache-Status: {cf} — {_CACHE_RULE_HINT}", kind="perf")
    return False


# ------------------------------------------------------------------- reporting

_SYMBOLS = {PASS: "✓", WARN: "⚠", FAIL: "✗", SKIP: "–"}


def format_check(c: CheckResult) -> str:
    """One human-readable result line."""
    return f"  {_SYMBOLS.get(c.status, '?')} {c.name}: {c.detail}"


def format_report(report: VerifyReport, *, strict: bool = False) -> str:
    """The full multi-line report ending in a summary verdict."""
    lines = [f"verify {report.base_url}"]
    lines += [format_check(c) for c in report.checks]
    n_fail = len(report.failures)
    n_warn = len(report.warnings)
    if report.ok(strict=strict):
        verdict = "PASS" if not n_warn else f"PASS ({n_warn} warning(s))"
    else:
        bits = []
        if n_fail:
            bits.append(f"{n_fail} failure(s)")
        if strict and n_warn:
            bits.append(f"{n_warn} warning(s) [--strict]")
        verdict = "FAIL — " + ", ".join(bits)
    lines.append(verdict)
    return "\n".join(lines)
