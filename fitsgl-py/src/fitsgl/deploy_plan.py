"""``fitsgl deploy`` planning — the pure, network-free heart of deployment.

Walks a built dataset directory and classifies every file into a *cache class*
(tile / pointer / asset), assigning each the ``Content-Type`` and
``Cache-Control`` it must be served with (``docs/deploy-design.md`` §4/§6). The
result is a :class:`DeployManifest` — both the wire description of what to upload
and the ledger that the *next* deploy diffs against to upload only what changed
(DP6).

Everything here is pure logic over the local filesystem: it reads files (to hash
them) but never touches the network, boto3, or Cloudflare. That keeps the
correctness-critical classification + diff fully unit-testable on fixtures; the
I/O lives in ``deploy.py`` / ``verify.py``.

Two facts from the supertile format (``docs/supertile-design.md``) shape the diff,
and the original deploy design predates both:

* A pyramid level is no longer one ``.fits.fz`` but a *set* of supertile files, so
  a real dataset can hold **hundreds** of tile objects — past the 100-URL
  Cloudflare purge-by-URL cap. The purge list must therefore be **batched**
  (:func:`chunk_purge_urls`).
* Re-tiling (a changed ``supertile_blocks``, or a grown mosaic) **changes the
  supertile filenames**, orphaning the old ones. Without an explicit *delete* set
  those dead objects pile up in R2 forever — precisely the cost the producer's
  "one copy, never versioned" constraint (DP3) exists to avoid. So the diff
  surfaces orphans (:attr:`DeployDiff.delete`).
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path, PurePath
from typing import Callable

from .serve import content_type_for  # single source of MIME truth (matches `fitsgl serve`)

#: The ledger file's name + schema version (``docs/deploy-design.md`` §6).
DEPLOY_MANIFEST_NAME = "deploy-manifest.json"
DEPLOY_MANIFEST_SCHEMA = 1

#: Default tile cache window (DP4): edge-serve warm tiles with no origin contact
#: for ``max-age``, then self-heal returning browsers in the background for the
#: ``stale-while-revalidate`` grace. 7 days + 30 days.
DEFAULT_TILE_MAX_AGE = 604800
DEFAULT_SWR_GRACE = 2592000

#: Site assets (``assets/index-*.js`` …) are content-hashed by Vite, so their URLs
#: are immutable by construction — a year + ``immutable`` is safe and standard.
ASSET_MAX_AGE = 31536000

#: Cloudflare's purge-by-URL cap (all plans, since Apr 2025): ≤100 URLs/call. A
#: supertiled dataset routinely exceeds this, so :func:`chunk_purge_urls` batches.
PURGE_URLS_PER_CALL = 100

#: How many tiles ``fitsgl deploy`` uploads to R2 at once. Concurrency only changes
#: wall-clock — the work is one PutObject per *changed* file (the ledger diff already
#: skips unchanged ones), so a wider stream does not add R2 operations. 8 keeps a
#: home/CI uplink saturated without exhausting the boto3 connection pool.
DEFAULT_UPLOAD_CONCURRENCY = 8

#: Read chunk for hashing — tiles are GB-scale, so never slurp a whole file.
_HASH_CHUNK = 1024 * 1024

# Cache classes. Each drives a distinct caching contract:
#   tile    — large, edge-cached, stable URL → long max-age+SWR; purge on change.
#   pointer — tiny index/entry files that MUST be fresh → no-cache (origin-served).
#   asset   — content-hashed viewer bundle → immutable (URL changes when bytes do).
CLASS_TILE = "tile"
CLASS_POINTER = "pointer"
CLASS_ASSET = "asset"


def classify_file(rel_posix: str) -> str:
    """The cache class of a dataset file by its dataset-relative POSIX path.

    Precedence (a path matches exactly one class):

    * ``*.fits.fz`` anywhere → ``tile`` (case-insensitive, matching ``content_type_for``).
    * anything under the literal ``assets/`` dir → ``asset`` (Vite content-hashed
      bundle). Matched case-*sensitively*: the bundle dir is always lowercase, and
      a band could legitimately be named e.g. ``Assets`` — whose mutable
      ``manifest.json`` pointer must not be frozen as an immutable asset.
    * everything else → ``pointer`` — ``fitsgl.json``, every ``manifest.json``,
      ``catalog.csv``, and ``index.html`` (the entry must reflect the latest
      deploy, so it is deliberately *not* an immutable asset).
    """
    if rel_posix.lower().endswith(".fits.fz"):
        return CLASS_TILE
    if rel_posix.startswith("assets/"):
        return CLASS_ASSET
    return CLASS_POINTER


def cache_control_for(
    cls: str,
    *,
    tile_max_age: int = DEFAULT_TILE_MAX_AGE,
    swr_grace: int = DEFAULT_SWR_GRACE,
    asset_max_age: int = ASSET_MAX_AGE,
) -> str:
    """The ``Cache-Control`` header for a cache class (DP4).

    Tiles get ``max-age`` + ``stale-while-revalidate`` (no ``s-maxage`` — it would
    disable SWR). Assets are ``immutable``. Pointers are ``no-cache`` + ``ETag``
    (the upload sets the ETag), so a rebuild shows at once.
    """
    if cls == CLASS_TILE:
        return f"public, max-age={tile_max_age}, stale-while-revalidate={swr_grace}"
    if cls == CLASS_ASSET:
        return f"public, max-age={asset_max_age}, immutable"
    return "public, no-cache"


@dataclass(frozen=True)
class DeployFile:
    """One deployable object: its dataset-relative path + how to serve it.

    ``path`` is always a '/'-separated path *within the dataset directory* (the
    object key sans any bucket ``prefix``, and the URL suffix under
    ``public_url``); ``deploy.py`` maps it to a key/URL. ``cls`` is the cache class
    (:func:`classify_file`); ``sha256`` is the content hash the diff keys on (DP6 —
    *not* R2's ETag, which is ``md5-of-md5s`` for a multipart upload and can't be
    compared to a local hash).
    """

    path: str
    cls: str
    content_type: str
    cache_control: str
    sha256: str
    size: int

    def to_dict(self) -> dict:
        # camelCase + JSON keyword `class` (matches docs/deploy-design.md §6).
        return {
            "path": self.path,
            "class": self.cls,
            "contentType": self.content_type,
            "cacheControl": self.cache_control,
            "sha256": self.sha256,
            "size": self.size,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "DeployFile":
        return cls(
            path=d["path"],
            cls=d["class"],
            content_type=d["contentType"],
            cache_control=d["cacheControl"],
            sha256=d["sha256"],
            size=d["size"],
        )


@dataclass
class DeployManifest:
    """The set of deployable objects + the incremental-sync ledger (DP6).

    Serialized to ``deploy-manifest.json`` in the bucket *after* a successful
    upload (so an interrupted deploy never falsely claims success), and fetched
    back at the start of the next deploy to compute the delta.
    """

    dataset: str
    files: list[DeployFile] = field(default_factory=list)
    schema_version: int = DEPLOY_MANIFEST_SCHEMA

    def by_path(self) -> dict[str, DeployFile]:
        """Path → entry index (paths are unique within a dataset dir)."""
        return {f.path: f for f in self.files}

    def to_dict(self) -> dict:
        return {
            "schemaVersion": self.schema_version,
            "dataset": self.dataset,
            "files": [f.to_dict() for f in self.files],
        }

    @classmethod
    def from_dict(cls, d: dict) -> "DeployManifest":
        # A legal-but-non-object JSON body (null/array/string from a truncated or
        # hand-edited ledger) would otherwise AttributeError on .get; raise a TypeError
        # the deploy's unreadable-ledger fallback catches.
        if not isinstance(d, dict):
            raise TypeError(f"deploy manifest must be a JSON object, got {type(d).__name__}")
        return cls(
            schema_version=d.get("schemaVersion", DEPLOY_MANIFEST_SCHEMA),
            dataset=d["dataset"],
            files=[DeployFile.from_dict(x) for x in d.get("files", [])],
        )


@dataclass
class DeployDiff:
    """The plan for one deploy: what to push, evict, and remove.

    * ``upload`` — files new, content-changed, or whose serving headers changed
      since the last deploy (PUT these).
    * ``purge``  — tile **paths** whose edge cache must be evicted: a tile is
      purged when its bytes changed, when only its serving headers changed (e.g. a
      lowered cache window — the warm edge copy must re-read the new header), or
      when it was *deleted* (its R2 object is gone, but a warm edge copy could
      still shadow the 404 for a client holding a pre-deploy manifest). New tiles
      are omitted (a never-seen URL has no edge entry); pointers/assets are omitted
      (no-cache / immutable URLs never go stale). Map to full URLs + batch with
      :func:`chunk_purge_urls`.
    * ``delete`` — paths present remotely but gone locally: orphans (e.g. old
      supertiles after a re-tile). Removing them honors DP3's "one copy, never
      accumulate" intent.
    * ``unchanged`` — present both sides with identical bytes (skipped).
    """

    upload: list[DeployFile] = field(default_factory=list)
    purge: list[str] = field(default_factory=list)
    delete: list[str] = field(default_factory=list)
    unchanged: list[DeployFile] = field(default_factory=list)

    @property
    def is_noop(self) -> bool:
        return not self.upload and not self.delete

    @property
    def upload_bytes(self) -> int:
        return sum(f.size for f in self.upload)


def _sha256_file(path: Path) -> str:
    """Streaming SHA-256 of ``path`` (chunked — tiles are too big to slurp)."""
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(_HASH_CHUNK), b""):
            h.update(chunk)
    return h.hexdigest()


def _iter_dataset_files(dataset_dir: Path):
    """Yield ``(abs_path, rel_posix)`` for every deployable file under the dir.

    Recurses, sorted for determinism. Skips dotfiles/dotdirs (``.DS_Store``,
    editor temp) and the ``deploy-manifest.json`` ledger itself (uploaded
    separately, last — it is never part of the diffed set).
    """
    for abs_path in sorted(dataset_dir.rglob("*")):
        if not abs_path.is_file():
            continue
        rel = abs_path.relative_to(dataset_dir)
        parts = rel.parts
        if any(part.startswith(".") for part in parts):
            continue
        rel_posix = PurePath(rel).as_posix()
        if rel_posix == DEPLOY_MANIFEST_NAME:
            continue
        yield abs_path, rel_posix


def build_deploy_manifest(
    dataset_dir: str | Path,
    *,
    dataset_name: str | None = None,
    tile_max_age: int = DEFAULT_TILE_MAX_AGE,
    swr_grace: int = DEFAULT_SWR_GRACE,
    include: Callable[[str], bool] | None = None,
) -> DeployManifest:
    """Classify + hash every file under a built dataset directory.

    ``dataset_name`` defaults to the directory's name. ``include`` (if given) keeps
    only files whose dataset-relative path it accepts — used by a ``--site-only``
    deploy to manifest just the viewer files *without* hashing the GB-scale tiles.
    Raises ``FileNotFoundError`` if the directory is missing or has no
    ``fitsgl.json`` (i.e. it is not a built dataset — run ``fitsgl build`` first).
    Files are returned sorted by path.
    """
    dataset_dir = Path(dataset_dir)
    if not dataset_dir.is_dir():
        raise FileNotFoundError(f"not a directory: {dataset_dir}")
    if not (dataset_dir / "fitsgl.json").is_file():
        raise FileNotFoundError(
            f"no fitsgl.json in {dataset_dir} — not a built dataset; run `fitsgl build` first"
        )
    name = dataset_name if dataset_name is not None else dataset_dir.name

    files: list[DeployFile] = []
    for abs_path, rel_posix in _iter_dataset_files(dataset_dir):
        if include is not None and not include(rel_posix):
            continue
        cls = classify_file(rel_posix)
        files.append(
            DeployFile(
                path=rel_posix,
                cls=cls,
                content_type=content_type_for(rel_posix),
                cache_control=cache_control_for(
                    cls, tile_max_age=tile_max_age, swr_grace=swr_grace
                ),
                sha256=_sha256_file(abs_path),
                size=abs_path.stat().st_size,
            )
        )
    return DeployManifest(dataset=name, files=files)


def diff_manifests(remote: DeployManifest | None, local: DeployManifest) -> DeployDiff:
    """Compute the deploy delta of ``local`` against the previously-deployed ``remote``.

    A ``None`` remote (first deploy / no ledger in the bucket) means everything is
    new: upload all, purge nothing (no edge entries exist yet), delete nothing.
    Change detection is by ``sha256`` (DP6); see :class:`DeployDiff` for the rules.
    """
    remote_by_path = remote.by_path() if remote is not None else {}
    diff = DeployDiff()
    seen: set[str] = set()
    for f in local.files:
        seen.add(f.path)
        prior = remote_by_path.get(f.path)
        if prior is None:
            diff.upload.append(f)  # brand-new object: no prior edge entry to purge
        elif prior.sha256 != f.sha256:
            diff.upload.append(f)
            if f.cls == CLASS_TILE:
                # Changed tile at a stable URL → its warm edge copy is now stale.
                diff.purge.append(f.path)
        elif prior.cache_control != f.cache_control or prior.content_type != f.content_type:
            # Same bytes, but the serving headers changed (e.g. a lowered
            # tile_max_age, or a corrected content-type after a code fix). R2 stores
            # these per object at PUT time, so re-PUT to update them — a hash-only
            # diff would otherwise silently discard the new window. Purge a tile so
            # its warm edge copy re-reads the new header.
            diff.upload.append(f)
            if f.cls == CLASS_TILE:
                diff.purge.append(f.path)
        else:
            diff.unchanged.append(f)
    diff.delete = sorted(p for p in remote_by_path if p not in seen)
    # A deleted tile's R2 object is gone, but its URL may still be warm at the edge,
    # shadowing the 404 with stale bytes for a client still holding a pre-deploy
    # manifest. Evict it in the same push→purge pass: there are no new bytes (only a
    # deletion), so DP5's push→purge ordering invariant holds trivially — the refill
    # can only resolve toward a clean 404.
    diff.purge.extend(p for p in diff.delete if classify_file(p) == CLASS_TILE)
    return diff


def chunk_purge_urls(urls: list[str], size: int = PURGE_URLS_PER_CALL) -> list[list[str]]:
    """Split purge URLs into ≤``size``-URL batches (Cloudflare's per-call cap).

    A supertiled dataset's purge set can exceed 100 URLs, so a full-rebuild purge
    becomes several calls rather than one. Order is preserved; an empty list yields
    no batches.
    """
    if size < 1:
        raise ValueError("purge batch size must be >= 1")
    return [urls[i : i + size] for i in range(0, len(urls), size)]


def write_deploy_manifest(path: str | Path, manifest: DeployManifest) -> None:
    """Serialize a deploy manifest to JSON on disk (camelCase wire form)."""
    path = Path(path)
    with path.open("w") as f:
        json.dump(manifest.to_dict(), f, indent=2, sort_keys=False)
        f.write("\n")


def read_deploy_manifest(path: str | Path) -> DeployManifest:
    """Load a deploy manifest from JSON on disk."""
    path = Path(path)
    with path.open() as f:
        return DeployManifest.from_dict(json.load(f))


def parse_deploy_manifest_bytes(data: bytes) -> DeployManifest:
    """Parse a deploy manifest from raw bytes (e.g. fetched from the bucket)."""
    return DeployManifest.from_dict(json.loads(data))
