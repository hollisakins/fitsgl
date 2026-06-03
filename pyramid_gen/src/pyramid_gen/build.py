"""``fitsgl build`` orchestration — one ``fitsgl.toml`` → one dataset directory.

Composes the tested primitives in-process (no ``python -`` heredocs, which flood
the console with ``<stdin>`` errors under multiprocessing): per-band
``build_pyramid``, then catalog ingestion, then emit ``fitsgl.json``. The build is
atomic — everything is written into a temp directory and swapped into place on
success — so a failed or interrupted build never leaves a half-written dataset
the viewer would choke on.
"""

from __future__ import annotations

import shutil
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from .build_pyramid import build_pyramid
from .catalog import ingest_catalog
from .config import DatasetConfig
from .fitsgl_config import build_fitsgl_config, default_view_dict
from .site import copy_viewer_into
from .stats import compute_band_histogram


@dataclass
class BuildResult:
    """What a build produced: the dataset dir + the emitted config path."""

    dataset_dir: Path
    config_path: Path
    band_levels: dict[str, int]  # band name -> number of pyramid levels
    site_written: bool = False  # whether the SSG viewer (index.html + assets) was copied in


def build_dataset(
    config: DatasetConfig,
    out_root: str | Path,
    *,
    processes: int | None = None,
    verify: bool = True,
    with_site: bool = True,
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
    """
    log = on_progress if on_progress is not None else (lambda _msg: None)
    out_root = Path(out_root)
    out_root.mkdir(parents=True, exist_ok=True)
    dataset_dir = out_root / config.name
    tmp_dir = out_root / f".{config.name}.building"
    # Clear any leftover temp from a previous interrupted build.
    if tmp_dir.exists():
        shutil.rmtree(tmp_dir)
    tmp_dir.mkdir(parents=True)

    try:
        band_levels: dict[str, int] = {}
        band_stats: dict[str, dict] = {}  # band name -> {"histogram": {...}} for the viewer panel
        total = len(config.bands)
        for i, band in enumerate(config.bands, 1):
            log(f"[{i}/{total}] band {band.name}  ({band.input.name})")
            manifest = build_pyramid(
                band.input,
                output_dir=tmp_dir / band.name,
                tile_size=config.build.tile_size,
                quantize_level=config.build.quantize_level,
                processes=processes,
                verify=verify,
                on_progress=lambda m: log(f"    {m}"),
            )
            band_levels[band.name] = manifest.n_levels
            histogram = compute_band_histogram(tmp_dir / band.name, manifest)
            if histogram is not None:
                band_stats[band.name] = {"histogram": histogram}

        catalog_url: str | None = None
        if config.catalog is not None:
            log(f"ingesting catalog {config.catalog.name}")
            ingest_catalog(config.catalog, tmp_dir / "catalog.csv")
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
        bands = [(b.name, b.label, tmp_dir / b.name / "manifest.json") for b in config.bands]
        config_path_tmp = tmp_dir / "fitsgl.json"
        build_fitsgl_config(
            bands,
            config_path_tmp,
            name=config.name,
            title=config.title,
            default_view=dv,
            catalog_url=catalog_url,
            band_stats=band_stats,
        )

        if with_site:
            log("writing viewer (index.html + assets)")
            copy_viewer_into(tmp_dir)
    except BaseException:
        # Don't leave a partial temp dir behind on any failure/interrupt.
        shutil.rmtree(tmp_dir, ignore_errors=True)
        raise

    # Swap into place: remove the old dataset dir, then rename temp -> final.
    if dataset_dir.exists():
        shutil.rmtree(dataset_dir)
    tmp_dir.replace(dataset_dir)

    return BuildResult(
        dataset_dir=dataset_dir,
        config_path=dataset_dir / "fitsgl.json",
        band_levels=band_levels,
        site_written=with_site,
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
