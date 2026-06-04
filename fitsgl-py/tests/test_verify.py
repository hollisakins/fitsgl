"""Tests for `fitsgl verify` (verify.py): pure helpers, the orchestration driven
by a stub fetcher, and one end-to-end run against a live `fitsgl serve`."""

import json
import threading

import pytest

from fitsgl.cli import main
from fitsgl.serve import FitsglRangeHandler, _ThreadingHTTPServer
from fitsgl.verify import (
    EDGE_CACHE_LIMIT_BYTES,
    FAIL,
    PASS,
    SKIP,
    WARN,
    CheckResult,
    FetchError,
    HttpResponse,
    VerifyReport,
    _content_length,
    _first_js_asset,
    _levels_to_probe,
    _mime_is_js,
    _mime_is_octet,
    _resolve,
    _sibling,
    format_check,
    format_report,
    verify_deployment,
)
from fitsgl.manifest import LevelInfo, Manifest, SupertileInfo


# ------------------------------------------------------------------ pure helpers


def test_resolve_joins_under_base():
    assert _resolve("https://x.org/ds", "fitsgl.json") == "https://x.org/ds/fitsgl.json"
    assert _resolve("https://x.org/ds/", "/f444w/manifest.json") == "https://x.org/ds/f444w/manifest.json"


def test_sibling_resolves_next_to_manifest():
    assert _sibling("f444w/manifest.json", "img_z0.fits.fz") == "f444w/img_z0.fits.fz"
    assert _sibling("manifest.json", "z0.fits.fz") == "z0.fits.fz"


@pytest.mark.parametrize(
    "html,expected",
    [
        ('<script type="module" src="./assets/index-abc.js"></script>', "assets/index-abc.js"),
        ("<script src='/assets/app.js'>", "assets/app.js"),
        ('<script src=assets/worker-1.js>', "assets/worker-1.js"),
        ('<script type="module" src="./assets/index.mjs">', "assets/index.mjs"),  # .mjs too
        ('<link href="./assets/x.css">', None),  # not a .js
        ('<link rel="manifest" href="assets/site.webmanifest.json">', None),  # .json not truncated to .js
        ("<p>no script here</p>", None),
    ],
)
def test_first_js_asset(html, expected):
    assert _first_js_asset(html) == expected


@pytest.mark.parametrize(
    "ct,is_js",
    [
        ("text/javascript", True),
        ("application/javascript", True),
        ("text/javascript; charset=utf-8", True),
        ("text/html", False),
        ("application/octet-stream", False),
        (None, False),
    ],
)
def test_mime_is_js(ct, is_js):
    assert _mime_is_js(ct) is is_js


def test_mime_is_octet():
    assert _mime_is_octet("application/octet-stream") is True
    assert _mime_is_octet("application/octet-stream; q=1") is True
    assert _mime_is_octet("text/html") is False
    assert _mime_is_octet(None) is False


def _lvl(z, fname, shape):
    return LevelInfo(
        z=z, filename=fname, compression="RICE_1", lossless=False, shape=shape,
        fpack_tile_count=[1, 1], pixel_scale_arcsec=0.03 * (z + 1), wcs={},
        supertiles=[SupertileInfo(filename=fname, tile_origin=[0, 0], tile_count=[1, 1])],
    )


def test_levels_to_probe_picks_z0_and_coarsest():
    m = Manifest(source_file="x", native_shape=[512, 512], n_levels=2,
                 levels=[_lvl(0, "z0.fits.fz", [512, 512]), _lvl(1, "z1.fits.fz", [256, 256]),
                         _lvl(2, "z2.fits.fz", [128, 128])])
    base, coarse = _levels_to_probe(m)
    assert base.z == 0 and coarse.z == 2


def test_levels_to_probe_single_level_collapses():
    m = Manifest(source_file="x", native_shape=[256, 256], n_levels=0, levels=[_lvl(0, "z0.fits.fz", [256, 256])])
    base, coarse = _levels_to_probe(m)
    assert base.z == 0 and coarse.z == 0


def test_content_length_parsing():
    assert _content_length(HttpResponse(200, {"content-length": "42"})) == 42
    assert _content_length(HttpResponse(200, {})) is None
    assert _content_length(HttpResponse(200, {"content-length": "nope"})) is None


def test_report_exit_codes():
    r = VerifyReport(base_url="x")
    r.add("a", PASS, "")
    assert r.exit_code() == 0 and r.ok()
    r.add("b", WARN, "", kind="perf")
    assert r.exit_code() == 0  # warnings don't fail by default
    assert r.exit_code(strict=True) == 1  # ...but do under --strict
    r.add("c", FAIL, "")
    assert r.exit_code() == 1 and not r.ok()


# ------------------------------------------------------ stub-driven orchestration

_CONFIG = {
    "schemaVersion": 1,
    "dataset": {"name": "ds", "bands": [{"name": "b", "tiles": ["b/manifest.json"], "grid": {"group": 0}}]},
    "defaultView": {"mode": "single", "band": "b"},
}
_MANIFEST = {
    "version": 2, "source_file": "x.fits", "native_shape": [512, 512], "fpack_tile_size": 256, "n_levels": 1,
    "levels": [
        {"z": 0, "filename": "b_z0.fits.fz", "compression": "RICE_1", "lossless": False, "shape": [512, 512],
         "fpack_tile_count": [2, 2], "pixel_scale_arcsec": 0.03, "wcs": {},
         "supertiles": [{"filename": "b_z0.fits.fz", "tile_origin": [0, 0], "tile_count": [2, 2]}]},
        {"z": 1, "filename": "b_z1.fits.fz", "compression": "RICE_1", "lossless": False, "shape": [256, 256],
         "fpack_tile_count": [1, 1], "pixel_scale_arcsec": 0.06, "wcs": {},
         "supertiles": [{"filename": "b_z1.fits.fz", "tile_origin": [0, 0], "tile_count": [1, 1]}]},
    ],
}


def make_fetch(**k):
    """A configurable in-memory dataset host. Each knob flips one contract aspect."""
    range_status = k.get("range_status", 206)
    tile_ct = k.get("tile_ct", "application/octet-stream")
    js_ct = k.get("js_ct", "text/javascript")
    js_status = k.get("js_status", 200)
    index_status = k.get("index_status", 200)
    index_html = k.get("index_html", '<!doctype html><script type="module" src="./assets/app-abc.js"></script>')
    cf_status = k.get("cf_status", None)
    cf_coarse = k.get("cf_coarse", cf_status)  # per-level override (coarse=HIT, z0=MISS scenarios)
    cf_z0 = k.get("cf_z0", cf_status)
    z0_len = k.get("z0_content_length", 4096)
    coarse_len = k.get("coarse_content_length", 1024)
    cors_allow = k.get("cors_allow", "*")
    cors_headers = k.get("cors_headers", "Range, If-None-Match")  # what the preflight permits
    config_status = k.get("config_status", 200)
    manifest_status = k.get("manifest_status", 200)
    config = k.get("config", _CONFIG)
    manifest = k.get("manifest", _MANIFEST)
    raise_on = k.get("raise_on", None)

    def fetch(method, url, headers=None):
        if raise_on is not None and raise_on in url:
            raise FetchError(f"boom {url}")
        if url.endswith("/fitsgl.json"):
            return HttpResponse(config_status, {"content-type": "application/json"}, json.dumps(config).encode())
        if url.endswith("/b/manifest.json"):
            return HttpResponse(manifest_status, {"content-type": "application/json"}, json.dumps(manifest).encode())
        if url.endswith("/index.html"):
            if index_status != 200:
                return HttpResponse(index_status, {}, b"")
            return HttpResponse(200, {"content-type": "text/html"}, index_html.encode())
        if "assets/" in url and url.endswith(".js"):
            return HttpResponse(js_status, {"content-type": js_ct}, b"")
        if url.endswith(".fits.fz"):
            is_z0 = url.endswith("b_z0.fits.fz")
            clen = z0_len if is_z0 else coarse_len
            if method == "HEAD":
                return HttpResponse(200, {"content-type": tile_ct, "content-length": str(clen)})
            if method == "OPTIONS":
                h = {}
                if cors_allow is not None:
                    h["access-control-allow-origin"] = cors_allow
                if cors_headers is not None:
                    h["access-control-allow-headers"] = cors_headers
                return HttpResponse(204, h)
            h = {"content-type": tile_ct, "content-length": "1024"}
            if range_status == 206:
                h["content-range"] = f"bytes 0-1023/{clen}"
            cf = cf_z0 if is_z0 else cf_coarse
            if cf is not None:
                h["cf-cache-status"] = cf
            return HttpResponse(range_status, h, b"\x00" * 16)
        return HttpResponse(404, {}, b"not found")

    return fetch


def status_of(report, name):
    return next(c.status for c in report.checks if c.name == name)


def test_all_good_passes():
    r = verify_deployment("https://x.org/ds", fetch=make_fetch())
    assert r.ok()
    assert status_of(r, "fitsgl.json loads") == PASS
    assert status_of(r, "manifest loads") == PASS
    assert status_of(r, "Range → 206") == PASS
    assert status_of(r, "tile MIME") == PASS
    assert status_of(r, "JS asset MIME") == PASS
    # No CDN in front → edge-cache checks are SKIP, never a failure.
    assert status_of(r, "edge cache (coarse)") == SKIP


def test_host_ignores_range_is_a_failure():
    r = verify_deployment("https://x.org/ds", fetch=make_fetch(range_status=200))
    assert not r.ok()
    rc = next(c for c in r.checks if c.name == "Range → 206")
    assert rc.status == FAIL and "200" in rc.detail and "ignores Range" in rc.detail


def test_unexpected_range_status_fails():
    r = verify_deployment("https://x.org/ds", fetch=make_fetch(range_status=416))
    assert status_of(r, "Range → 206") == FAIL


def test_tile_served_as_html_fails():
    r = verify_deployment("https://x.org/ds", fetch=make_fetch(tile_ct="text/html"))
    assert status_of(r, "tile MIME") == FAIL


def test_unexpected_tile_mime_warns():
    r = verify_deployment("https://x.org/ds", fetch=make_fetch(tile_ct="application/x-fits"))
    assert status_of(r, "tile MIME") == WARN
    assert r.ok()  # a warning alone passes


def test_js_asset_wrong_mime_fails():
    r = verify_deployment("https://x.org/ds", fetch=make_fetch(js_ct="text/html"))
    assert status_of(r, "JS asset MIME") == FAIL


def test_data_only_deploy_skips_js_check():
    r = verify_deployment("https://x.org/ds", fetch=make_fetch(index_status=404))
    assert status_of(r, "JS asset MIME") == SKIP
    assert r.ok()


def test_cors_preflight_pass_and_fail():
    ok = verify_deployment("https://x.org/ds", origin="https://embed.example", fetch=make_fetch(cors_allow="*"))
    assert status_of(ok, "CORS preflight") == PASS
    bad = verify_deployment("https://x.org/ds", origin="https://embed.example", fetch=make_fetch(cors_allow=None))
    assert status_of(bad, "CORS preflight") == FAIL


def test_cors_not_checked_without_origin():
    r = verify_deployment("https://x.org/ds", fetch=make_fetch())
    assert not any(c.name == "CORS preflight" for c in r.checks)


def test_edge_cache_hit_passes_miss_warns():
    hit = verify_deployment("https://x.org/ds", fetch=make_fetch(cf_status="HIT"))
    assert status_of(hit, "edge cache (coarse)") == PASS and hit.ok()
    miss = verify_deployment("https://x.org/ds", fetch=make_fetch(cf_status="MISS"))
    coarse = next(c for c in miss.checks if c.name == "edge cache (coarse)")
    assert coarse.status == WARN and "Cache Rule" in coarse.detail
    # MISS only matters for CI under --strict.
    assert miss.ok() and not miss.ok(strict=True)


def test_oversize_z0_object_warns_with_supertile_hint():
    r = verify_deployment("https://x.org/ds", fetch=make_fetch(z0_content_length=EDGE_CACHE_LIMIT_BYTES + 1))
    c = next(c for c in r.checks if c.name == "object size (z0)")
    assert c.status == WARN and "supertile_blocks" in c.detail
    assert r.ok()  # perf warning, not a failure


def test_unreachable_host_fails_cleanly():
    r = verify_deployment("https://x.org/ds", fetch=make_fetch(raise_on="fitsgl.json"))
    assert not r.ok()
    assert r.checks[-1].status == FAIL and "could not reach" in r.checks[-1].detail
    # Aborts after the prerequisite fails — no tile probing attempted.
    assert not any(c.name == "Range → 206" for c in r.checks)


def test_bad_config_json_fails():
    def fetch(method, url, headers=None):
        if url.endswith("/fitsgl.json"):
            return HttpResponse(200, {}, b"not json{{{")
        return HttpResponse(404, {})
    r = verify_deployment("https://x.org/ds", fetch=fetch)
    assert status_of(r, "fitsgl.json loads") == FAIL


def test_format_report_renders_verdict():
    r = verify_deployment("https://x.org/ds", fetch=make_fetch(range_status=200))
    text = format_report(r)
    assert text.startswith("verify https://x.org/ds")
    assert "✗ Range → 206" in text
    assert text.strip().endswith("failure(s)") or "FAIL" in text


def test_cors_missing_range_header_fails():
    # Allow-Origin is fine, but the preflight doesn't permit the Range request
    # header → the browser blocks the embedder's ranged GET (the whole mechanism).
    r = verify_deployment("https://x.org/ds", origin="https://embed.example",
                          fetch=make_fetch(cors_allow="*", cors_headers="If-None-Match"))
    c = next(c for c in r.checks if c.name == "CORS preflight")
    assert c.status == FAIL and "Range" in c.detail


def test_cors_wildcard_allow_headers_passes():
    r = verify_deployment("https://x.org/ds", origin="https://embed.example",
                          fetch=make_fetch(cors_allow="*", cors_headers="*"))
    assert status_of(r, "CORS preflight") == PASS


def test_z0_miss_with_coarse_hit_blames_the_cap():
    # The discriminating case: coarse caches but z0 doesn't → z0 specifically over-cap.
    r = verify_deployment("https://x.org/ds", fetch=make_fetch(cf_coarse="HIT", cf_z0="MISS"))
    assert status_of(r, "edge cache (coarse)") == PASS
    z0 = next(c for c in r.checks if c.name == "edge cache (z0)")
    assert z0.status == WARN and "512 MB" in z0.detail and "supertile_blocks" in z0.detail


def test_z0_miss_with_coarse_miss_blames_the_cache_rule():
    # Both MISS → the Cache Rule is the cause; z0 must NOT wrongly blame the size cap.
    r = verify_deployment("https://x.org/ds", fetch=make_fetch(cf_coarse="MISS", cf_z0="MISS"))
    z0 = next(c for c in r.checks if c.name == "edge cache (z0)")
    assert z0.status == WARN and "Cache Rule" in z0.detail and "512 MB cap" not in z0.detail


def test_redirecting_config_url_fails_with_location_hint():
    def fetch(method, url, headers=None):
        return HttpResponse(301, {"location": "https://acct.r2.dev/ds/fitsgl.json"})
    r = verify_deployment("https://data.example/ds", fetch=fetch)
    c = r.checks[0]
    assert c.status == FAIL and "redirects to" in c.detail and "r2.dev" in c.detail


@pytest.mark.parametrize(
    "bad_config",
    [
        {"dataset": []},                                   # dataset not an object
        {"dataset": "nope"},                               # dataset a string
        {"dataset": {"bands": {"x": 1}}},                  # bands a dict, not a list
        {"dataset": {"bands": []}},                        # bands empty
        {"dataset": {"bands": ["not-an-object"]}},         # band not an object
        {"dataset": {"bands": [{"name": "b", "tiles": {}}]}},   # tiles not a list
        {"dataset": {"bands": [{"name": "b", "tiles": []}]}},   # tiles empty
        {"dataset": {"bands": [{"name": "b", "tiles": [123]}]}},  # tiles[0] not a string
    ],
)
def test_malformed_config_structure_fails_cleanly(bad_config):
    # A valid-JSON-but-wrong-shape config must FAIL cleanly, never crash with a traceback.
    r = verify_deployment("https://x.org/ds", fetch=make_fetch(config=bad_config))
    assert not r.ok()
    assert any(c.status == FAIL for c in r.checks)  # and no exception escaped


def test_206_without_content_range_fails_with_clear_message():
    def fetch(method, url, headers=None):
        if url.endswith("/fitsgl.json"):
            return HttpResponse(200, {}, json.dumps(_CONFIG).encode())
        if url.endswith("/b/manifest.json"):
            return HttpResponse(200, {}, json.dumps(_MANIFEST).encode())
        if url.endswith(".fits.fz"):
            return HttpResponse(206, {"content-type": "application/octet-stream"})  # no Content-Range
        return HttpResponse(404, {})
    r = verify_deployment("https://x.org/ds", fetch=fetch)
    c = next(c for c in r.checks if c.name == "Range → 206")
    assert c.status == FAIL and "no Content-Range" in c.detail


def test_empty_supertiles_level_fails_cleanly():
    bad_manifest = json.loads(json.dumps(_MANIFEST))
    bad_manifest["levels"][0]["supertiles"] = []  # corrupt: explicit empty list
    r = verify_deployment("https://x.org/ds", fetch=make_fetch(manifest=bad_manifest))
    assert status_of(r, "manifest loads") == FAIL  # no IndexError on supertiles[0]


def test_config_non_200_aborts():
    r = verify_deployment("https://x.org/ds", fetch=make_fetch(config_status=503))
    assert status_of(r, "fitsgl.json loads") == FAIL
    assert not any(c.name == "manifest loads" for c in r.checks)  # aborts before manifest


def test_manifest_non_200_aborts():
    r = verify_deployment("https://x.org/ds", fetch=make_fetch(manifest_status=404))
    assert status_of(r, "manifest loads") == FAIL
    assert not any(c.name == "Range → 206" for c in r.checks)  # aborts before tile probing


def test_js_asset_head_non_200_fails():
    r = verify_deployment("https://x.org/ds", fetch=make_fetch(js_status=403))
    c = next(c for c in r.checks if c.name == "JS asset MIME")
    assert c.status == FAIL and "403" in c.detail


def test_index_without_js_reference_skips():
    r = verify_deployment("https://x.org/ds", fetch=make_fetch(index_html="<!doctype html><p>no script</p>"))
    assert status_of(r, "JS asset MIME") == SKIP


def test_edge_probe_fetcherror_is_swallowed():
    # A flaky perf probe must not fail the run or crash — just omit the perf lines.
    # Raise on the COARSE tile only (the Range/MIME correctness checks probe z0, so
    # raising there would fail those instead of exercising the perf-swallow path).
    r = verify_deployment("https://x.org/ds", fetch=make_fetch(raise_on="b_z1.fits.fz"))
    assert r.ok()
    assert status_of(r, "Range → 206") == PASS  # correctness (z0) unaffected
    assert not any(c.name == "object size (coarse)" for c in r.checks)  # HEAD raised → swallowed
    assert not any(c.name == "edge cache (coarse)" for c in r.checks)  # GET raised → no record


_ONE_LEVEL_MANIFEST = {
    "version": 2, "source_file": "x.fits", "native_shape": [256, 256], "fpack_tile_size": 256, "n_levels": 0,
    "levels": [
        {"z": 0, "filename": "b_z0.fits.fz", "compression": "RICE_1", "lossless": False, "shape": [256, 256],
         "fpack_tile_count": [1, 1], "pixel_scale_arcsec": 0.03, "wcs": {},
         "supertiles": [{"filename": "b_z0.fits.fz", "tile_origin": [0, 0], "tile_count": [1, 1]}]},
    ],
}


def test_single_level_pyramid_probes_perf_once():
    r = verify_deployment("https://x.org/ds", fetch=make_fetch(manifest=_ONE_LEVEL_MANIFEST))
    assert r.ok()
    # Only the coarse perf pair — no redundant z0 entry (base level IS the coarse level).
    assert sum(1 for c in r.checks if c.name.startswith("object size")) == 1
    assert not any(c.name == "edge cache (z0)" for c in r.checks)


@pytest.mark.parametrize("status,symbol", [(PASS, "✓"), (WARN, "⚠"), (FAIL, "✗"), (SKIP, "–"), ("weird", "?")])
def test_format_check_symbols(status, symbol):
    line = format_check(CheckResult(name="n", status=status, detail="d"))
    assert line.strip().startswith(symbol)


def test_cli_verify_subcommand_exit_codes():
    # Drive the actual CLI wrapper (argparse + _cmd_verify + exit-code propagation).
    good = make_fetch()
    import fitsgl.cli as cli_mod
    # main() builds its own UrllibFetcher, so patch verify_deployment to use our stub.
    real = cli_mod.verify_deployment
    cli_mod.verify_deployment = lambda url, **kw: real(url, fetch=good, **{k: v for k, v in kw.items() if k != "fetch"})
    try:
        assert main(["verify", "https://x.org/ds"]) == 0
        assert main(["verify", "https://x.org/ds", "--strict"]) == 0
    finally:
        cli_mod.verify_deployment = real


# --------------------------------------------------------- live-server integration

_REAL_MANIFEST = dict(_MANIFEST)  # served verbatim by the live server


@pytest.fixture
def live_dataset(tmp_path):
    """A minimal, contract-valid dataset served by the real FitsglRangeHandler."""
    root = tmp_path / "ds"
    (root / "b").mkdir(parents=True)
    (root / "assets").mkdir()
    (root / "fitsgl.json").write_text(json.dumps(_CONFIG))
    (root / "b" / "manifest.json").write_text(json.dumps(_REAL_MANIFEST))
    (root / "b" / "b_z0.fits.fz").write_bytes(bytes(range(256)) * 16)  # 4096 bytes
    (root / "b" / "b_z1.fits.fz").write_bytes(bytes(range(256)) * 8)  # 2048 bytes
    (root / "index.html").write_text('<!doctype html><script type="module" src="./assets/app-abc.js"></script>')
    (root / "assets" / "app-abc.js").write_text("export const x = 1;\n")
    handler = type("Bound", (FitsglRangeHandler,), {"served_root": root.resolve()})
    httpd = _ThreadingHTTPServer(("127.0.0.1", 0), handler)
    port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield port
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=5)


def test_verify_against_live_serve(live_dataset):
    port = live_dataset
    # Real UrllibFetcher (fetch=None) against the reference contract server.
    report = verify_deployment(f"http://127.0.0.1:{port}", origin="https://embed.example")
    assert report.ok(), format_report(report)
    assert status_of(report, "Range → 206") == PASS
    assert status_of(report, "tile MIME") == PASS  # serve sends application/octet-stream
    assert status_of(report, "JS asset MIME") == PASS  # serve sends text/javascript
    assert status_of(report, "CORS preflight") == PASS  # serve answers OPTIONS with ACAO: *
    # `fitsgl serve` is not a CDN, so it sends no CF-Cache-Status → the edge check skips.
    assert status_of(report, "edge cache (coarse)") == SKIP
