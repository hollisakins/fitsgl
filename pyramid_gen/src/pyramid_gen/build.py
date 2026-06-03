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


@dataclass
class BuildResult:
    """What a build produced: the dataset dir + the emitted config path."""

    dataset_dir: Path
    config_path: Path
    band_levels: dict[str, int]  # band name -> number of pyramid levels


def build_dataset(
    config: DatasetConfig,
    out_root: str | Path,
    *,
    processes: int | None = None,
    verify: bool = True,
    on_progress: Callable[[str], None] | None = None,
) -> BuildResult:
    """Build the whole dataset described by ``config`` under ``out_root``.

    Produces ``out_root/<dataset.name>/`` containing one ``<band>/`` pyramid per
    band, an optional ``catalog.csv``, and ``fitsgl.json``. Re-runnable: an
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
        bands = [(b.name, tmp_dir / b.name / "manifest.json") for b in config.bands]
        config_path_tmp = tmp_dir / "fitsgl.json"
        build_fitsgl_config(
            bands,
            config_path_tmp,
            name=config.name,
            title=config.title,
            default_view=dv,
            catalog_url=catalog_url,
        )
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
    )
