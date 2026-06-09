"""``fitsgl deploy`` engine — push a built dataset to Cloudflare R2 + purge the edge.

This is the I/O half of deployment; the pure classify/diff logic lives in
``deploy_plan.py``. The orchestration (:func:`deploy_dataset`) runs the
deploy flow:

1. **classify** the dataset dir → a local :class:`DeployManifest` (slice 1).
2. **diff** it against the previously-deployed ledger fetched from the bucket
   (DP6) → upload / delete / purge sets.
3. **upload** the delta — tiles first, then pointers/assets, then orphan deletes;
   set bucket CORS (DP8).
4. **purge** the changed + deleted tile URLs from Cloudflare — strictly *after* the
   whole upload (DP5: push→purge), batched ≤100 URLs/call.
5. write the ledger **last** (after the purge), so its new hashes mark *both* the
   upload and the purge as done — a purge failure leaves the old ledger, and the
   next deploy self-heals by re-detecting + re-purging the change.
6. **verify** the live URL (DP7) unless disabled.

The S3/R2 and Cloudflare calls sit behind the :class:`DeployTarget` and
:class:`Purger` protocols, so the orchestration is fully unit-testable with fakes —
no boto3, no network. The real adapters (:class:`R2Target` — boto3, the optional
``pip install 'fitsgl[deploy]'`` extra; :class:`CloudflarePurge` — stdlib urllib)
are only constructed on the live path. ``--site-only`` and the interactive upload
confirmation are CLI concerns wired in slice 4 with the ``deploy`` subcommand.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from concurrent.futures import FIRST_EXCEPTION, ThreadPoolExecutor, wait
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Callable, Protocol

from .collection import COLLECTION_STAGING_DIR
from .config import DeployConfig  # re-exported below; config.py owns the parsed structure
from .deploy_plan import (
    CLASS_POINTER,
    CLASS_TILE,
    DEFAULT_UPLOAD_CONCURRENCY,
    DEPLOY_MANIFEST_NAME,
    DeployDiff,
    DeployFile,
    DeployManifest,
    build_deploy_manifest,
    cache_control_for,
    chunk_purge_urls,
    diff_manifests,
    parse_deploy_manifest_bytes,
)
from .verify import VerifyReport, verify_deployment

__all__ = [
    "DeployConfig", "DeployError", "DeployResult", "DeployTarget", "Purger",
    "R2Target", "CloudflarePurge", "deploy_dataset", "deploy_collection_root",
    "object_key", "public_url_for",
]

#: CORS headers the embedder's ranged fetch needs to read (mirrors ``serve.py``).
_CORS_EXPOSE = ["Content-Range", "Content-Length", "Accept-Ranges", "ETag"]
_CLOUDFLARE_PURGE_URL = "https://api.cloudflare.com/client/v4/zones/{zone_id}/purge_cache"


class DeployError(Exception):
    """A deploy step failed (bad credentials, an R2/Cloudflare API error, …)."""


# --------------------------------------------------------------- I/O protocols


class DeployTarget(Protocol):
    """The object-store operations the orchestration needs (S3/R2 surface)."""

    def get_bytes(self, key: str) -> bytes | None:
        """Object body, or ``None`` if the key does not exist."""
        ...

    def put_file(self, key: str, path: Path, *, content_type: str, cache_control: str) -> None:
        """Upload a local file (streamed/multipart for large objects)."""
        ...

    def put_bytes(self, key: str, data: bytes, *, content_type: str, cache_control: str) -> None:
        """Upload an in-memory object (the ledger)."""
        ...

    def delete(self, key: str) -> None:
        ...

    def put_cors(self, origins: list[str], methods: list[str], headers: list[str]) -> None:
        ...


class Purger(Protocol):
    """The Cloudflare cache-purge operation."""

    def purge(self, urls: list[str]) -> None:
        ...


# ------------------------------------------------------------------- pure keys


def object_key(prefix: str, path: str) -> str:
    """The bucket key for a dataset-relative ``path`` under an optional ``prefix``."""
    p = prefix.strip("/")
    return f"{p}/{path}" if p else path


def public_url_for(public_url: str, path: str) -> str:
    """The served URL for a dataset-relative ``path`` (what Cloudflare caches)."""
    return f"{public_url.rstrip('/')}/{path.lstrip('/')}"


def _manifest_bytes(manifest: DeployManifest) -> bytes:
    return (json.dumps(manifest.to_dict(), indent=2) + "\n").encode("utf-8")


# ----------------------------------------------------------------- the result


@dataclass
class DeployResult:
    """What a deploy did (or, for ``--dry-run``, would do)."""

    diff: DeployDiff
    dry_run: bool
    uploaded: list[str] = field(default_factory=list)  # dataset-relative paths PUT
    deleted: list[str] = field(default_factory=list)  # orphan paths removed
    purged: list[str] = field(default_factory=list)  # full URLs purged from the edge
    verify_report: VerifyReport | None = None
    aborted: bool = False  # the confirm callback declined before any writes

    @property
    def upload_bytes(self) -> int:
        return self.diff.upload_bytes


def is_site_file(path: str) -> bool:
    """True for the viewer files a ``--site-only`` deploy touches (entry + bundle)."""
    return path == "index.html" or path.startswith("assets/")


def _filter_manifest(manifest: DeployManifest, keep: Callable[[str], bool]) -> DeployManifest:
    return DeployManifest(
        dataset=manifest.dataset,
        files=[f for f in manifest.files if keep(f.path)],
        schema_version=manifest.schema_version,
    )


def _merge_site_ledger(remote: DeployManifest | None, local_site: DeployManifest) -> DeployManifest:
    """The ledger to write after a ``--site-only`` deploy: the prior ledger's non-site
    entries (tiles/pointers, untouched) plus the freshly-deployed site entries — so a
    partial viewer refresh never orphans the data files' entries."""
    kept = [f for f in (remote.files if remote is not None else []) if not is_site_file(f.path)]
    merged = sorted(kept + list(local_site.files), key=lambda f: f.path)
    return DeployManifest(dataset=local_site.dataset, files=merged)


# ----------------------------------------------------------- the orchestration


def _upload_files(
    target: DeployTarget,
    files: list[DeployFile],
    *,
    dataset_dir: Path,
    prefix: str,
    max_workers: int,
    log: Callable[[str], None],
) -> list[str]:
    """PUT every file in ``files`` to ``target``, up to ``max_workers`` in flight.

    A barrier: returns only once *all* of ``files`` are up — callers lean on that to
    keep tiles strictly ahead of the pointers that reference them. The cost is one
    PutObject per file: the ledger diff already pruned unchanged files and nothing
    here HEADs or lists, so widening the stream buys speed at no extra R2 operations.

    On the first failure, stops launching pending uploads and re-raises, so a partial
    failure never reaches the success ledger. Returns the uploaded paths in ``files``
    order — independent of completion order, so the DeployResult stays deterministic.
    """
    def _put(f: DeployFile) -> None:
        log(f"upload {f.path} ({f.cls}, {f.size / (1024 * 1024):.2f} MB)")
        target.put_file(
            object_key(prefix, f.path),
            dataset_dir / f.path,
            content_type=f.content_type,
            cache_control=f.cache_control,
        )

    if not files:
        return []
    workers = max(1, min(max_workers, len(files)))
    if workers == 1:  # keep the simple, fully-ordered path when there's nothing to parallelize
        for f in files:
            _put(f)
        return [f.path for f in files]

    with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="fitsgl-upload") as ex:
        futures = [ex.submit(_put, f) for f in files]
        done, _ = wait(futures, return_when=FIRST_EXCEPTION)
        for fut in futures:
            fut.cancel()  # no-op on the running/finished ones; drops the not-yet-started
        for fut in done:
            fut.result()  # re-raise the first failure (the cancel above stops the rest)
    return [f.path for f in files]


def deploy_dataset(
    dataset_dir: str | Path,
    config: DeployConfig,
    target: DeployTarget,
    *,
    purger: Purger | None = None,
    dry_run: bool = False,
    run_verify: bool = True,
    site_only: bool = False,
    set_cors: bool = True,
    max_workers: int = DEFAULT_UPLOAD_CONCURRENCY,
    verify_fn: Callable[[str], VerifyReport] | None = None,
    confirm: Callable[[DeployDiff], bool] | None = None,
    on_progress: Callable[[str], None] | None = None,
) -> DeployResult:
    """Deploy ``dataset_dir`` to ``target`` (R2) per the §5.1 flow.

    ``purger`` (Cloudflare) is optional: without it the edge purge is skipped with a
    warning (tiles may serve stale until ``max-age``). ``dry_run`` does steps 1–2
    and returns the plan without any writes. ``site_only`` pushes just the viewer
    files (``index.html`` + ``assets/``) — hashing only those, and merging their
    entries into the prior ledger so the data files' entries are preserved.
    ``confirm`` (if given) is called with the computed diff before any writes; return
    ``False`` to abort. ``set_cors`` (default True) sets bucket CORS once per call; a
    workspace deploy passes ``False`` for every field and sets CORS once itself for
    the shared bucket, avoiding N redundant ``put_bucket_cors`` calls. ``max_workers``
    is how many files upload at once (a barrier
    separates the tile group from the pointer/asset group, so a higher value never
    races a manifest ahead of its tiles). ``run_verify`` runs the post-deploy
    contract check (``verify_fn`` overrides the checker — tests inject a fake to avoid
    real network). ``on_progress`` is called with human-readable status lines.
    """
    log = on_progress if on_progress is not None else (lambda _msg: None)
    dataset_dir = Path(dataset_dir)
    ledger_key = object_key(config.prefix, DEPLOY_MANIFEST_NAME)

    # 1. Classify the local dataset (only the viewer files for --site-only).
    local = build_deploy_manifest(
        dataset_dir, tile_max_age=config.tile_max_age, swr_grace=config.swr_grace,
        include=is_site_file if site_only else None,
    )

    # 2. Diff against the previously-deployed ledger in the bucket (DP6). For
    #    --site-only, diff only within the site subset so data files aren't touched.
    remote_full = _fetch_remote_manifest(target, ledger_key, log)
    if site_only:
        if remote_full is None:
            log("warning: --site-only with no prior deploy — run a full `fitsgl deploy` first for the data")
        remote_for_diff = _filter_manifest(remote_full, is_site_file) if remote_full is not None else None
    else:
        remote_for_diff = remote_full
    diff = diff_manifests(remote_for_diff, local)

    log(
        f"plan{' (site-only)' if site_only else ''}: {len(diff.upload)} to upload "
        f"({diff.upload_bytes / (1024 * 1024):.1f} MB), {len(diff.delete)} to delete, "
        f"{len(diff.purge)} to purge, {len(diff.unchanged)} unchanged"
    )
    if dry_run:
        return DeployResult(diff=diff, dry_run=True)
    if confirm is not None and not confirm(diff):
        log("aborted")
        return DeployResult(diff=diff, dry_run=False, aborted=True)

    result = DeployResult(diff=diff, dry_run=False)

    # 3. Upload the delta — all tiles first (a barrier), then pointers/assets, so a
    #    freshly-visible (no-cache) manifest never references a tile that isn't up yet.
    #    Within each group, up to max_workers stream in parallel.
    tiles = [f for f in diff.upload if f.cls == CLASS_TILE]
    others = [f for f in diff.upload if f.cls != CLASS_TILE]
    for group in (tiles, others):
        result.uploaded += _upload_files(
            target, group,
            dataset_dir=dataset_dir, prefix=config.prefix, max_workers=max_workers, log=log,
        )

    # Delete orphans (e.g. supertiles renamed by a re-tile) so R2 never accumulates.
    for path in diff.delete:
        log(f"delete {path}")
        target.delete(object_key(config.prefix, path))
        result.deleted.append(path)

    # Bucket CORS (DP8) — R2 rejects AllowedHeaders ["*"], so list "range" explicitly.
    # Skipped for --site-only (a viewer refresh, not a data-access change) and when
    # set_cors=False (a workspace deploy sets it once for the shared bucket itself).
    if not site_only and set_cors:
        log(f"set CORS (origin {config.viewer_origin})")
        target.put_cors([config.viewer_origin], ["GET", "HEAD"], ["range"])

    # 4. Purge the edge — strictly after the full upload (DP5: push→purge), batched.
    #    (site-only touches no tiles, so diff.purge is empty: index.html is no-cache
    #    and assets are immutable-hashed — neither needs eviction.)
    if diff.purge:
        urls = [public_url_for(config.public_url, p) for p in diff.purge]
        if purger is not None:
            n_batches = len(chunk_purge_urls(urls))
            log(f"purge {len(urls)} URL(s) from the edge ({n_batches} call(s))")
            purger.purge(urls)
            result.purged = urls
        else:
            log(
                f"warning: no zone_id/CLOUDFLARE_API_TOKEN → skipping edge purge of {len(urls)} URL(s); "
                "changed tiles may serve stale from the edge until max-age expires"
            )

    # 5. The ledger LAST — *after* the purge, so its new hashes are the success marker
    #    for BOTH the upload and the purge. If the purge raises, the ledger stays at
    #    the old hashes, so the next deploy re-detects the change and re-purges
    #    (self-heals) instead of a committed new ledger masking an un-evicted edge copy.
    #    For --site-only, merge the fresh site entries into the prior ledger so the
    #    untouched data files' entries are preserved. It's a pointer → no-cache.
    ledger = _merge_site_ledger(remote_full, local) if site_only else local
    target.put_bytes(
        ledger_key, _manifest_bytes(ledger),
        content_type="application/json", cache_control=cache_control_for(CLASS_POINTER),
    )

    # 6. Verify the live deployment (DP7) — read-only, so it runs after the ledger.
    if run_verify:
        log(f"verify {config.public_url}")
        vfn = verify_fn if verify_fn is not None else verify_deployment
        result.verify_report = vfn(config.public_url)

    return result


def deploy_collection_root(
    out_root: str | Path,
    config: DeployConfig,
    target: DeployTarget,
    *,
    purger: Purger | None = None,
    dry_run: bool = False,
    max_workers: int = DEFAULT_UPLOAD_CONCURRENCY,
    confirm: Callable[[DeployDiff], bool] | None = None,
    on_progress: Callable[[str], None] | None = None,
) -> DeployResult:
    """Deploy the collection landing page to bucket prefix "".

    Targets the staged ``out_root/.collection/`` dir (``collection.json`` +
    ``index.html`` + ``assets/`` — see :func:`collection.emit_collection`), forcing
    ``prefix=""`` so those files land at the bucket root next to (not inside) every
    field's prefix. A thin wrapper over :func:`deploy_dataset`:

    * ``.collection/`` holds no field subdirs, so the ``rglob`` walk stays tiny — no
      double-upload of field tiles, no ``include`` predicate needed.
    * ``set_cors=False`` — a workspace deploy sets bucket CORS once for the shared
      bucket itself; the root must not re-set it.
    * ``run_verify=False`` — the root has ``collection.json``, not ``fitsgl.json``,
      which the data-contract verifier expects; the per-field deploys verify the data.
      Its ``diff.purge`` is always empty (no tiles; ``index.html``/``collection.json``
      are ``no-cache`` pointers, ``assets/*`` immutable), so a missing zone/token is
      harmless here.
    """
    staging = Path(out_root) / COLLECTION_STAGING_DIR
    root_config = replace(config, prefix="")  # the collection root IS prefix ""
    return deploy_dataset(
        staging,
        root_config,
        target,
        purger=purger,
        dry_run=dry_run,
        run_verify=False,
        site_only=False,
        set_cors=False,
        max_workers=max_workers,
        confirm=confirm,
        on_progress=on_progress,
    )


def _fetch_remote_manifest(
    target: DeployTarget, ledger_key: str, log: Callable[[str], None]
) -> DeployManifest | None:
    """The previously-deployed ledger, or ``None`` (first deploy / unreadable)."""
    raw = target.get_bytes(ledger_key)
    if raw is None:
        log("no prior deploy-manifest in the bucket — treating as a first deploy (full upload)")
        return None
    try:
        return parse_deploy_manifest_bytes(raw)
    except (ValueError, TypeError, KeyError):
        log("warning: prior deploy-manifest is unreadable — treating as a first deploy (full upload)")
        return None


# --------------------------------------------------------------- R2 adapter (boto3)


class R2Target:
    """:class:`DeployTarget` backed by Cloudflare R2 via boto3 (the ``fitsgl[deploy]``
    extra). Not unit-tested (needs boto3 + a live bucket); the orchestration is
    tested against a fake. Calls are the verified S3-compat surface from §6."""

    #: Upload as a single PutObject up to this size, multipart above it. R2 caps a
    #: single PUT at 5 GiB; tiles (incl. supertile blocks, ≤~512 MB) sit well under 4
    #: GiB, so this makes every realistic tile *one* Class-A op instead of dozens of
    #: UploadPart calls — only a pathologically large object falls back to multipart.
    _MULTIPART_THRESHOLD = 4 * 1024**3
    _MULTIPART_CHUNKSIZE = 512 * 1024**2  # parts for the rare >4 GiB object

    def __init__(
        self,
        *,
        bucket: str,
        endpoint: str,
        access_key: str,
        secret_key: str,
        region: str = "auto",
        max_pool_connections: int = 10,
    ) -> None:
        try:
            import boto3  # noqa: PLC0415 — lazy so the package imports without the extra
            from boto3.s3.transfer import TransferConfig  # noqa: PLC0415
            from botocore.config import Config  # noqa: PLC0415
            from botocore.exceptions import ClientError  # noqa: PLC0415
        except ImportError as e:  # pragma: no cover - exercised only without the extra
            raise DeployError(
                "fitsgl deploy needs boto3 — install the extra: pip install 'fitsgl[deploy]'"
            ) from e
        self.bucket = bucket
        self._client_error = ClientError
        # Size the connection pool to the upload concurrency so parallel PUTs don't
        # queue on a too-small pool (botocore defaults to 10) and warn.
        self._s3 = boto3.client(
            "s3",
            endpoint_url=endpoint,
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            region_name=region,
            config=Config(max_pool_connections=max_pool_connections),
        )
        self._transfer = TransferConfig(
            multipart_threshold=self._MULTIPART_THRESHOLD,
            multipart_chunksize=self._MULTIPART_CHUNKSIZE,
            # We already parallelize across files, so keep per-file part concurrency
            # modest — only the rare multipart object uses it.
            max_concurrency=4,
        )

    @classmethod
    def from_config(cls, config: DeployConfig, *, concurrency: int = DEFAULT_UPLOAD_CONCURRENCY) -> "R2Target":
        """Build from a :class:`DeployConfig` + R2 credentials in the environment.

        ``concurrency`` (the deploy's parallel-upload width) sizes the HTTP connection
        pool so concurrent PUTs each get a connection instead of serializing on it.
        """
        access_key = os.environ.get("R2_ACCESS_KEY_ID")
        secret_key = os.environ.get("R2_SECRET_ACCESS_KEY")
        if not access_key or not secret_key:
            raise DeployError(
                "set R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY in the environment "
                "(R2 S3-compatible credentials)"
            )
        return cls(
            bucket=config.bucket, endpoint=config.endpoint,
            access_key=access_key, secret_key=secret_key,
            max_pool_connections=max(10, concurrency + 4),
        )

    def get_bytes(self, key: str) -> bytes | None:  # pragma: no cover - needs a live bucket
        try:
            resp = self._s3.get_object(Bucket=self.bucket, Key=key)
            return resp["Body"].read()
        except self._client_error as e:
            code = e.response.get("Error", {}).get("Code", "")
            if code in ("NoSuchKey", "404"):
                return None  # object absent → first deploy
            if code in ("NoSuchBucket", "NoSuchBucketPolicy"):
                # A missing bucket is a misconfig, NOT a first deploy — fail loudly up
                # front rather than masking it as "no prior manifest" and full-uploading.
                raise DeployError(f"R2 bucket {self.bucket!r} not found — check [deploy].bucket") from e
            raise DeployError(f"R2 get_object {key!r} failed: {e}") from e

    def put_file(self, key: str, path: Path, *, content_type: str, cache_control: str) -> None:  # pragma: no cover
        # upload_file streams from disk (never slurps the whole file into RAM) and
        # switches to multipart only above our raised threshold — boto3 does not
        # auto-detect the content-type, so we pass it explicitly. Safe to call from
        # several threads at once: the botocore client is thread-safe for calls.
        self._s3.upload_file(
            str(path), self.bucket, key,
            ExtraArgs={"ContentType": content_type, "CacheControl": cache_control},
            Config=self._transfer,
        )

    def put_bytes(self, key: str, data: bytes, *, content_type: str, cache_control: str) -> None:  # pragma: no cover
        self._s3.put_object(
            Bucket=self.bucket, Key=key, Body=data, ContentType=content_type, CacheControl=cache_control
        )

    def delete(self, key: str) -> None:  # pragma: no cover - needs a live bucket
        self._s3.delete_object(Bucket=self.bucket, Key=key)

    def put_cors(self, origins: list[str], methods: list[str], headers: list[str]) -> None:  # pragma: no cover
        try:
            self._s3.put_bucket_cors(
                Bucket=self.bucket,
                CORSConfiguration={
                    "CORSRules": [
                        {
                            "AllowedOrigins": origins,
                            "AllowedMethods": methods,
                            "AllowedHeaders": headers,
                            "ExposeHeaders": _CORS_EXPOSE,
                            "MaxAgeSeconds": 3600,
                        }
                    ]
                },
            )
        except self._client_error as e:
            # Setting bucket CORS is a bucket-config op, not an object op — an R2
            # "Object Read & Write" token uploads every file fine and then trips here.
            # Translate the bare AccessDenied into the actionable fix (r2-setup.md §4a).
            code = e.response.get("Error", {}).get("Code", "")
            if code == "AccessDenied":
                raise DeployError(
                    f"R2 denied setting CORS on bucket {self.bucket!r}: the API token lacks "
                    "bucket-config permission. Re-create it with 'Admin Read & Write' (still "
                    "scoped to this bucket) — 'Object Read & Write' can upload files but not set "
                    "CORS. See docs/r2-setup.md §4a. (The upload itself already succeeded.)"
                ) from e
            raise DeployError(f"R2 put_bucket_cors on {self.bucket!r} failed: {e}") from e


# ----------------------------------------------------- Cloudflare purge (stdlib)


class CloudflarePurge:
    """:class:`Purger` over the Cloudflare purge-by-URL API (stdlib urllib).

    The HTTP POST is behind a ``post`` seam so the batching + error handling are
    unit-testable without network; the default posts for real."""

    def __init__(
        self,
        zone_id: str,
        api_token: str,
        *,
        post: Callable[[str, bytes, dict[str, str]], dict] | None = None,
        timeout: float = 15.0,
    ) -> None:
        self.zone_id = zone_id
        self._api_token = api_token
        self._timeout = timeout
        self._post = post if post is not None else self._urllib_post

    @classmethod
    def from_config(cls, config: DeployConfig) -> "CloudflarePurge | None":
        """Build from config + ``CLOUDFLARE_API_TOKEN``; ``None`` if either is absent
        (purge is then skipped — the deploy still works, tiles just expire by TTL)."""
        token = os.environ.get("CLOUDFLARE_API_TOKEN")
        if not config.zone_id or not token:
            return None
        return cls(config.zone_id, token)

    def purge(self, urls: list[str]) -> None:
        url = _CLOUDFLARE_PURGE_URL.format(zone_id=self.zone_id)
        headers = {"Authorization": f"Bearer {self._api_token}", "Content-Type": "application/json"}
        for batch in chunk_purge_urls(urls):
            body = json.dumps({"files": batch}).encode("utf-8")
            result = self._post(url, body, headers)
            # A proxy/gateway error can surface as valid-but-non-dict JSON; funnel it
            # through DeployError too rather than an opaque AttributeError on .get.
            if not isinstance(result, dict) or not result.get("success", False):
                raise DeployError(f"Cloudflare purge failed: {result!r}")

    def _urllib_post(self, url: str, data: bytes, headers: dict[str, str]) -> dict:  # pragma: no cover - network
        req = urllib.request.Request(url, data=data, method="POST", headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=self._timeout) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            try:
                return json.loads(e.read())  # the API returns a JSON error body
            except (ValueError, OSError):
                raise DeployError(f"Cloudflare purge HTTP {e.code}: {e.reason}") from e
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise DeployError(f"Cloudflare purge request failed: {e}") from e
