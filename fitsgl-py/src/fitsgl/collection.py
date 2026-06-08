"""``fitsgl index`` — the collection landing page emitted at the deploy root.

A *collection* is the multi-field landing page: a ``collection.json`` listing every
built field + the picker-mode viewer (``index.html`` + ``assets/``, the same vendored
bundle a field dataset ships). Both are staged in a **dotdir** ``out/.collection/`` so
the collection-root deploy targets a small directory — never an ``rglob`` over the
whole multi-field tree — and so the leading dot keeps it invisible to
``_iter_dataset_files`` / ``_prune_orphan_bands``.

Everything here is pure logic over the local filesystem (it reads each field's built
``fitsgl.json`` + first band ``manifest.json`` to enrich a card, never the network);
the only side effect beyond writing ``collection.json`` is copying the vendored
viewer via :func:`site.copy_viewer_into`. See ``docs/workspace-design.md``.
"""

from __future__ import annotations

import json
import math
import warnings
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from .site import copy_viewer_into

#: The collection wire-format version (independent of ``FITSGL_SCHEMA_VERSION`` —
#: the picker validates this one; ``COLLECTION_SCHEMA_VERSION`` in the TS viewer
#: must match).
COLLECTION_SCHEMA_VERSION = 1

#: The dotdir under the output root where the collection root is staged + deployed
#: from. Dotted so ``_iter_dataset_files`` (skips dot-segments) and
#: ``_prune_orphan_bands`` (skips dotdirs) never touch it.
COLLECTION_STAGING_DIR = ".collection"

#: The landing-page manifest file name (a sibling of each field's ``fitsgl.json``,
#: but at the bucket root / prefix "").
COLLECTION_MANIFEST_NAME = "collection.json"


@dataclass
class EmitResult:
    """What :func:`emit_collection` produced."""

    staging_dir: Path
    fields: list[dict]  # the field entries written into collection.json
    skipped: list[str] = field(default_factory=list)  # prefixes skipped (not built)


def _read_center(dataset_dir: Path, fitsgl_cfg: dict) -> dict | None:
    """Best-effort field-center ``{ra, dec}`` from the first band's z=0 WCS reference
    point (``CRVAL``). A cheap, good-enough proxy for a footprint; ``None`` on any
    missing/non-finite value so a card just omits the position chip."""
    try:
        bands = fitsgl_cfg["dataset"]["bands"]
        manifest_rel = bands[0]["tiles"][0]
        manifest = json.loads((dataset_dir / manifest_rel).read_text())
        z0 = next(lvl for lvl in manifest["levels"] if lvl.get("z") == 0)
        wcs = z0["wcs"]
        ra, dec = float(wcs["CRVAL1"]), float(wcs["CRVAL2"])
    except (KeyError, IndexError, OSError, ValueError, TypeError, StopIteration):
        return None
    if not (math.isfinite(ra) and math.isfinite(dec)):
        return None
    return {"ra": ra, "dec": dec}


def collection_field_entry(prefix: str, dataset_dir: Path, *, title_override: str | None = None) -> dict | None:
    """One ``fields[]`` entry from a built field directory, or ``None`` if not built.

    ``prefix`` is the field's deploy prefix — it becomes the entry's ``name`` (the
    picker links to ``<name>/``). Reads ``dataset_dir/fitsgl.json`` for the title +
    band count and the first band's manifest for a best-effort sky ``center``.
    Returns ``None`` (caller skips + warns) when ``fitsgl.json`` is absent — the
    field is in the workspace but not built under this ``out`` root.
    """
    cfg_path = dataset_dir / "fitsgl.json"
    if not cfg_path.is_file():
        return None
    try:
        cfg = json.loads(cfg_path.read_text())
        dataset = cfg["dataset"]
    except (OSError, ValueError, KeyError, TypeError):
        return None

    entry: dict = {"name": prefix}
    title = title_override or dataset.get("title") or dataset.get("name") or prefix
    entry["title"] = title
    bands = dataset.get("bands")
    if isinstance(bands, list):
        entry["bandCount"] = len(bands)
    center = _read_center(dataset_dir, cfg)
    if center is not None:
        entry["center"] = center
    return entry


def build_collection(name: str, title: str | None, fields: list[dict]) -> dict:
    """Assemble the ``collection.json`` object (pure). ``fields`` are the entries
    from :func:`collection_field_entry`."""
    collection: dict = {"name": name}
    if title is not None:
        collection["title"] = title
    return {
        "schemaVersion": COLLECTION_SCHEMA_VERSION,
        "collection": collection,
        "fields": fields,
    }


def write_collection(path: str | Path, obj: dict) -> None:
    """Serialize a collection manifest to JSON on disk (matches the field configs:
    indent=2, trailing newline, ``allow_nan=False`` so a NaN never reaches the
    browser)."""
    path = Path(path)
    with path.open("w") as f:
        json.dump(obj, f, indent=2, sort_keys=False, allow_nan=False)
        f.write("\n")


def emit_collection(
    out_root: str | Path,
    *,
    name: str,
    title: str | None,
    field_specs: list[tuple[str, Path, str | None]],
    on_progress: Callable[[str], None] | None = None,
) -> EmitResult:
    """Write ``out_root/.collection/`` (``collection.json`` + picker viewer).

    ``field_specs`` is ``(prefix, dataset_dir, title_override)`` per workspace field.
    A field whose ``dataset_dir`` is not built (no ``fitsgl.json``) is skipped with a
    warning so the landing page lists only deployable fields. The picker is the same
    vendored bundle a field ships (:func:`site.copy_viewer_into`), which self-detects
    collection vs field mode at load time.
    """
    log = on_progress if on_progress is not None else (lambda _msg: None)
    out_root = Path(out_root)
    entries: list[dict] = []
    skipped: list[str] = []
    for prefix, dataset_dir, title_override in field_specs:
        entry = collection_field_entry(prefix, dataset_dir, title_override=title_override)
        if entry is None:
            warnings.warn(
                f"fitsgl index: field {prefix!r} is not built at {dataset_dir} — "
                "skipping it in the landing page (run `fitsgl build` for it first)",
                stacklevel=2,
            )
            skipped.append(prefix)
            continue
        entries.append(entry)

    staging = out_root / COLLECTION_STAGING_DIR
    staging.mkdir(parents=True, exist_ok=True)
    obj = build_collection(name, title, entries)
    write_collection(staging / COLLECTION_MANIFEST_NAME, obj)
    log(f"wrote {COLLECTION_STAGING_DIR}/{COLLECTION_MANIFEST_NAME} ({len(entries)} field(s))")
    log("writing picker viewer (index.html + assets)")
    copy_viewer_into(staging)
    return EmitResult(staging_dir=staging, fields=entries, skipped=skipped)
