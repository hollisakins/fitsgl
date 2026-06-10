"""``fitsgl build`` orchestration — one ``fitsgl.toml`` → one dataset directory.

Composes the tested primitives in-process (no ``python -`` heredocs, which flood
the console with ``<stdin>`` errors under multiprocessing): per-band
``build_pyramid``, then catalog ingestion, then emit ``fitsgl.json``.

The build is **resumable**, band by band. Each band is built into a per-band
staging dir and promoted into the dataset the instant it finishes, so a build that
is cancelled (Ctrl-C) or dies partway leaves every *completed* band durably on
disk; a re-run skips those and picks up where it left off. Completion is marked by
the band's ``manifest.json`` (``build_pyramid`` writes it last) plus all the level
files it references — a half-built band has no manifest, so it is never mistaken
for done and is simply rebuilt. The dataset-level products stay atomic: a band is
promoted by an atomic rename, and ``fitsgl.json`` (the viewer's gate) is written to
a temp file and renamed into place, so the viewer never reads a half-written band
dir or config.

Reuse keys on a band's *presence*, not on the parameters it was built with, so
``--overwrite`` forces a full clean rebuild of every band — pass it after changing
a ``[build]`` knob (tile size, quantization, supertile blocks). ``fitsgl.json`` and
the viewer are always re-emitted regardless.
"""

from __future__ import annotations

import json
import os
import shutil
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from .bands import detect_band, detect_band_from_filename
from .build_pyramid import DEFAULT_SUPERTILE_BLOCKS, build_pyramid
from .catalog import ingest_catalog
from .config import DatasetConfig
from .dataset import grid_hash
from .fitsgl_config import build_fitsgl_config, default_view_dict
from .manifest import Manifest, read_manifest
from .placed_tiles import GridFrame, plan_grid_frames
from .site import copy_viewer_into
from .stats import compute_band_histogram, compute_band_trilogy_stats


@dataclass
class BuildResult:
    """What a build produced: the dataset dir + the emitted config path."""

    dataset_dir: Path
    config_path: Path
    band_levels: dict[str, int]  # band name -> number of pyramid levels
    site_written: bool = False  # whether the SSG viewer (index.html + assets) was copied in
    reused_bands: tuple[str, ...] = ()  # bands reused from a prior build (not rebuilt)


def _band_cache_valid(band_dir: Path, frame: GridFrame | None = None) -> Manifest | None:
    """Return the cached manifest if ``band_dir`` is a complete, reusable build, else None.

    A band is reusable when its ``manifest.json`` loads and every supertile file it
    references is present. ``build_pyramid`` writes ``manifest.json`` last, so its mere
    presence already implies a finished band; the file-existence sweep additionally
    guards against a hand-deleted or partially-synced level file.

    With ``frame`` (the shared grid this band must now sit on), the cached band's z=0
    ``grid_hash`` must still match the frame's. A footprint change — a band added,
    removed, or resized that grew the co-gridded group's union — flips the expected
    hash, so the stale band is rebuilt onto the new shared grid rather than silently
    left at the old shape (which would break the RGB composite).
    """
    manifest_path = band_dir / "manifest.json"
    if not manifest_path.is_file():
        return None
    try:
        manifest = read_manifest(manifest_path)
    except (OSError, ValueError, KeyError):
        return None
    if not manifest.levels:
        return None
    for level in manifest.levels:
        for st in level.supertiles:
            if not (band_dir / st.filename).is_file():
                return None
    if frame is not None:
        z0 = next((lvl for lvl in manifest.levels if lvl.z == 0), None)
        if z0 is None:
            return None
        want = grid_hash(dict(frame.global_header()), frame.shape)
        got = grid_hash(z0.wcs, manifest.native_shape)
        if want != got:
            return None
    return manifest


def _band_staging_dir(dataset_dir: Path, band_name: str) -> Path:
    """The per-band staging dir a freshly-built band is assembled in before promotion.

    A dotfile sibling of the final band dir (same filesystem → the promotion is an
    atomic rename). Hidden from ``_prune_orphan_bands`` and the deploy ledger, and
    swept at the start of every build so a cancelled run leaves no litter.
    """
    return dataset_dir / f".{band_name}.building"


def _promote_band(staging: Path, final: Path) -> None:
    """Move a finished band's staging dir into its final place, atomically where possible.

    For a band built for the first time ``final`` does not exist and the rename is fully
    atomic. Re-building an existing band (``--overwrite`` / cache miss) must drop the old
    dir first — a tiny non-atomic window, but the band being replaced was already slated
    for a rebuild, and a crash inside it just leaves no manifest, so the next run rebuilds.
    """
    if final.exists():
        shutil.rmtree(final)
    os.replace(staging, final)


def _prune_orphan_bands(dataset_dir: Path, keep: set[str]) -> None:
    """Delete band dirs left over from a previous config that no longer lists them.

    A directory is an orphaned band iff it holds a ``manifest.json`` and its name is not a
    currently-configured band (and is not a dotfile staging dir or the viewer ``assets/``).
    Mirrors the old whole-dataset temp-swap, which dropped unlisted bands implicitly; run
    only after every configured band built, so a resume never prunes work still pending.
    """
    for entry in dataset_dir.iterdir():
        if not entry.is_dir() or entry.name.startswith(".") or entry.name in keep:
            continue
        if (entry / "manifest.json").is_file():
            shutil.rmtree(entry)


def _write_fitsgl_config_atomic(out_dir: Path, build: Callable[[Path], object]) -> Path:
    """Write ``fitsgl.json`` via a temp file + atomic rename, returning its final path.

    ``build`` is a zero-arg callable that writes the config to the path it is given (it is
    handed the temp path). Renaming the finished file into place means the viewer's gating
    config is never observed half-written, even if the process dies mid-serialize.
    """
    final = out_dir / "fitsgl.json"
    tmp = out_dir / ".fitsgl.json.tmp"
    build(tmp)
    os.replace(tmp, final)
    return final


def _load_prev_band_stats(fitsgl_json: Path) -> dict[str, dict]:
    """Map band name → its ``stats`` block from a previously-built ``fitsgl.json``.

    Lets a reused band keep the display stats the prior build computed without
    re-decoding its full native level (the trilogy stats scan every native supertile —
    the single most expensive read in the pyramid). Returns ``{}`` when the file is
    absent or unreadable, in which case the caller recomputes.
    """
    try:
        cfg = json.loads(fitsgl_json.read_text())
        bands = cfg["dataset"]["bands"]
    except (OSError, ValueError, KeyError, TypeError):
        return {}
    out: dict[str, dict] = {}
    for b in bands:
        if isinstance(b, dict) and "name" in b and isinstance(b.get("stats"), dict):
            out[b["name"]] = b["stats"]
    return out


def _detect_band_pivot(input_path: Path) -> float | None:
    """Pivot wavelength (microns) for a band's first input, for trilogy rainbow
    ordering, or ``None`` when the filter can't be detected.

    Merges the primary header with the 2D image HDU's (JWST/HST mosaics often carry
    ``FILTER``/``INSTRUME`` in the primary while the science pixels live in an
    extension) and runs the pure :func:`bands.detect_band`, falling back to the
    filename when the merged header has no instrument/filter keywords. Lenient: any
    read/parse failure yields ``None`` (the viewer then orders the band by
    declaration order).
    """
    try:
        from astropy.io import fits

        with fits.open(input_path) as hdul:
            merged = fits.Header()
            merged.update(hdul[0].header)
            two_d = [
                h
                for h in hdul
                if isinstance(getattr(h, "shape", None), tuple) and len(h.shape) == 2
            ]
            if len(two_d) == 1:
                merged.update(two_d[0].header)
        det = detect_band(merged) or detect_band_from_filename(input_path.name)
        return det.pivot_um if det is not None else None
    except Exception:  # noqa: BLE001 - pivot is an optional ordering hint; never fail the build
        return None


def build_dataset(
    config: DatasetConfig,
    out_root: str | Path,
    *,
    processes: int | None = None,
    verify: bool = True,
    with_site: bool = True,
    overwrite: bool = False,
    on_progress: Callable[[str], None] | None = None,
) -> BuildResult:
    """Build the whole dataset described by ``config`` under ``out_root``.

    Produces ``out_root/<dataset.name>/`` containing one ``<band>/`` pyramid per
    band, an optional ``catalog.csv``, ``fitsgl.json``, and (unless
    ``with_site=False``) the bundled SSG viewer (``index.html`` + ``assets/``) so
    the directory is a self-contained, deployable static site. Re-runnable: an
    existing dataset directory is replaced atomically only after the new one is
    fully built. ``processes`` caps the per-level worker pool (None = auto, one per
    level up to the cpu count). ``verify`` (default True) reads each level back to
    check the lossy round-trip; set False to skip that second full decode per level
    on very large mosaics. ``on_progress`` (if given) is called with human-readable
    status lines as each band + level builds; defaults to silent.

    Resumable: each band is built in a per-band staging dir and promoted into the
    dataset the instant it finishes, so a cancelled or crashed build keeps every band
    that completed before it stopped. A re-run reuses those in place (their display
    stats carried over from the prior ``fitsgl.json``) and rebuilds only the rest;
    ``fitsgl.json`` and the viewer are always re-emitted. Set ``overwrite=True`` to
    rebuild every band from scratch (use it after changing a ``[build]`` parameter,
    since reuse keys on a band's presence, not on how it was built).
    """
    log = on_progress if on_progress is not None else (lambda _msg: None)
    out_root = Path(out_root)
    out_root.mkdir(parents=True, exist_ok=True)
    dataset_dir = out_root / config.name
    dataset_dir.mkdir(parents=True, exist_ok=True)
    # Sweep per-band staging dirs left by a previous interrupted build, before deciding
    # what is already done (a half-built band has no manifest there anyway).
    for stale in dataset_dir.glob(".*.building"):
        shutil.rmtree(stale, ignore_errors=True)

    band_levels: dict[str, int] = {}
    band_stats: dict[str, dict] = {}  # band name -> {"histogram": {...}} for the viewer panel
    band_pivots: dict[str, float] = {}  # band name -> pivot µm, for the trilogy rainbow
    reused: list[str] = []
    # Stats of reused bands are carried over from the prior build's fitsgl.json so a
    # reused band never re-decodes its native level just to recompute them.
    prev_stats = {} if overwrite else _load_prev_band_stats(dataset_dir / "fitsgl.json")
    total = len(config.bands)
    # Plan the shared grid across all bands up front (header-only, cheap): a band that
    # co-grids with another but covers a smaller footprint gets a GridFrame to be
    # NaN-padded onto, so the bands composite in RGB. None where a band already
    # defines the grid (the superset) or has no co-gridded sibling — built as-is.
    frames: list[GridFrame | None] = (
        plan_grid_frames([band.inputs for band in config.bands])
        if config.build.shared_grid
        else [None] * total
    )
    for i, (band, frame) in enumerate(zip(config.bands, frames), 1):
        final = dataset_dir / band.name
        multi = len(band.inputs) > 1
        src_desc = f"{len(band.inputs)} tiles" if multi else band.inputs[0].name
        cached = None if overwrite else _band_cache_valid(final, frame)
        if cached is not None:
            log(f"[{i}/{total}] band {band.name}  (reused — already built; pass --overwrite to rebuild)")
            manifest = cached
            reused.append(band.name)
        else:
            log(f"[{i}/{total}] band {band.name}  ({src_desc})")
            staging = _band_staging_dir(dataset_dir, band.name)
            if staging.exists():
                shutil.rmtree(staging)
            manifest = build_pyramid(
                band.inputs,
                output_dir=staging,
                # Multi-tile (or shared-grid-padded) bands get clean {slug}_z… filenames;
                # a plain single-input band keeps its file-stem default (unchanged output).
                stem=band.name if (multi or frame is not None) else None,
                tile_size=config.build.tile_size,
                quantize_level=config.build.quantize_level,
                supertile_blocks=(
                    config.build.supertile_blocks
                    if config.build.supertile_blocks is not None
                    else DEFAULT_SUPERTILE_BLOCKS
                ),
                processes=processes,
                verify=verify,
                grid_frame=frame,
                on_progress=lambda m: log(f"    {m}"),
            )
            # Promote only now that build_pyramid has written the manifest: the band
            # becomes visible (and resume-skippable on a re-run) atomically, never partial.
            _promote_band(staging, final)
        band_levels[band.name] = manifest.n_levels

        # Pivot wavelength (cheap header read) for the trilogy rainbow's blue→red
        # ordering; optional, so a band whose filter isn't recognized just omits it.
        pivot = _detect_band_pivot(band.inputs[0])
        if pivot is not None:
            band_pivots[band.name] = pivot

        # Display stats for the viewer's stretch panel. A reused band keeps the stats the
        # prior build computed (recomputing the trilogy stats would re-decode the whole
        # native level); recompute only when missing (no / unreadable prior fitsgl.json,
        # or the band was freshly built this run).
        if cached is not None and band.name in prev_stats:
            band_stats[band.name] = prev_stats[band.name]
        else:
            histogram = compute_band_histogram(final, manifest)
            if histogram is not None:
                stats: dict = {"histogram": histogram}
                # Global trilogy levels (native z=0) — color-preserving stretch with no
                # live rescan. Independently optional: omitted ⇒ the viewer falls back to
                # its percentile auto-stretch for that band.
                trilogy = compute_band_trilogy_stats(final, manifest)
                if trilogy is not None:
                    stats["trilogy"] = trilogy
                band_stats[band.name] = stats

    # Drop bands a previous config listed that this one no longer does — now that every
    # configured band is in place (so a resume never prunes pending work), and before
    # fitsgl.json marks the dataset complete (so a "done" dataset never carries orphans).
    _prune_orphan_bands(dataset_dir, {b.name for b in config.bands})

    catalog_url: str | None = None
    if config.catalog is not None:
        log(f"ingesting catalog {config.catalog.name}")
        ingest_catalog(config.catalog, dataset_dir / "catalog.csv")
        catalog_url = "catalog.csv"

    view = config.viewer
    # A single-band default with no explicit band falls back to the first band.
    band = view.band if view.band is not None else (config.bands[0].name if view.mode == "single" else None)
    dv = default_view_dict(
        mode=view.mode,
        band=band,
        r=view.r,
        g=view.g,
        b=view.b,
        stretch=view.stretch,
        colormap=view.colormap,
        north_up=view.north_up,
    )
    log("writing fitsgl.json")
    bands = [(b.name, b.label, dataset_dir / b.name / "manifest.json") for b in config.bands]
    config_path = _write_fitsgl_config_atomic(
        dataset_dir,
        lambda tmp: build_fitsgl_config(
            bands,
            tmp,
            name=config.name,
            title=config.title,
            default_view=dv,
            catalog_url=catalog_url,
            band_stats=band_stats,
            band_pivots=band_pivots,
        ),
    )

    if with_site:
        log("writing viewer (index.html + assets)")
        copy_viewer_into(dataset_dir)

    return BuildResult(
        dataset_dir=dataset_dir,
        config_path=config_path,
        band_levels=band_levels,
        site_written=with_site,
        reused_bands=tuple(reused),
    )


def write_site(
    config: DatasetConfig,
    out_root: str | Path,
    *,
    on_progress: Callable[[str], None] | None = None,
) -> Path:
    """Re-emit only the bundled viewer into an already-built dataset directory.

    Overwrites ``index.html`` + ``assets/`` in ``out_root/<dataset.name>/`` in
    place, leaving the pyramid data, ``fitsgl.json``, and catalog untouched (no
    atomic temp-swap — nothing else is rewritten). This is the cheap counterpart
    to a full :func:`build_dataset`: use it to refresh the SSG viewer after
    rebuilding the viewer app, skipping the multi-minute pyramid rebuild.

    Raises ``FileNotFoundError`` if there is no built dataset at the target (its
    ``fitsgl.json`` is missing) — run a full ``fitsgl build`` first — or if the
    viewer bundle was never vendored.
    """
    log = on_progress if on_progress is not None else (lambda _msg: None)
    dataset_dir = Path(out_root) / config.name
    if not (dataset_dir / "fitsgl.json").is_file():
        raise FileNotFoundError(
            f"no built dataset at {dataset_dir} (missing fitsgl.json); "
            "run a full `fitsgl build` first"
        )
    log("writing viewer (index.html + assets)")
    copy_viewer_into(dataset_dir)
    return dataset_dir
