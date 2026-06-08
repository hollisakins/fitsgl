"""``fitsgl demo`` — a one-command synthetic dataset for kicking the tires.

Generates a few synthetic, co-gridded NIRCam-like bands, builds their tile
pyramids plus the bundled SSG viewer into a self-contained dataset directory, and
(optionally) serves it. No FITS input or ``fitsgl.toml`` required: it is the
fastest path from a fresh checkout to the real ``<FitsExplorer>`` UI in a browser.

The default view is an RGB **trilogy** composite (r=f444w, g=f277w, b=f150w), so
the per-band weight knobs are on screen the instant the page loads. Under the hood
it reuses the exact same path as ``fitsgl build`` (:func:`build.build_dataset`), so
what you see is the shipped viewer bundle against a real pyramid — not a
special-case preview. The synthetic FITS are staged in a temp dir and discarded;
only the dataset directory survives.
"""

from __future__ import annotations

import tempfile
from collections.abc import Callable
from pathlib import Path

from .build import BuildResult, build_dataset
from .catalog import write_catalog_csv
from .config import BandSpec, BuildSpec, DatasetConfig, ViewerSpec
from .synthetic import generate_synthetic_mosaic

#: (band slug, display label, RNG seed). Named like NIRCam wide filters so the
#: filename band-detection assigns real pivot wavelengths (the trilogy rainbow's
#: blue→red ordering) and the RGB roles below are physically sensible. Distinct
#: seeds give each band its own source field + NaN blobs → a registered-colour
#: composite with rare all-NaN overlaps (exercises the transparent path).
DEMO_BANDS: tuple[tuple[str, str, int], ...] = (
    ("f150w", "F150W", 3),
    ("f277w", "F277W", 2),
    ("f444w", "F444W", 1),
)

#: Default RGB role assignment: reddest filter → red channel, bluest → blue.
DEMO_RGB: dict[str, str] = {"r": "f444w", "g": "f277w", "b": "f150w"}


def build_demo(
    out_root: str | Path,
    *,
    name: str = "demo",
    size: int = 512,
    n_sources: int | None = None,
    rotation_deg: float = 30.0,
    with_catalog: bool = True,
    processes: int | None = None,
    verify: bool = True,
    on_progress: Callable[[str], None] | None = None,
) -> BuildResult:
    """Generate a synthetic dataset and build it (data + ``fitsgl.json`` + viewer).

    Writes ``out_root/<name>/`` as a self-contained, deployable static site, exactly
    like :func:`build.build_dataset` (which it calls). Three co-gridded synthetic
    bands (``size`` × ``size``, WCS rolled ``rotation_deg``°) are generated into a
    temporary directory, built into pyramids, then discarded — only the dataset
    survives. ``n_sources`` defaults to ~50 per 512² of area (the demo reference's
    field density). ``with_catalog`` overlays the bluest band's sources as markers.
    ``processes``/``verify`` pass straight through to the build. Returns the
    :class:`build.BuildResult`.

    Raises ``ValueError`` for a non-positive ``size`` and ``FileNotFoundError`` if
    the SSG viewer bundle was never vendored (``fitsgl/_viewer`` missing).
    """
    if size < 1:
        raise ValueError(f"demo size must be a positive pixel count (got {size})")
    log = on_progress if on_progress is not None else (lambda _msg: None)
    sources = n_sources if n_sources is not None else max(50, round(50 * (size / 512) ** 2))

    from astropy.io import fits  # local: heavy, and only needed to stage the inputs

    with tempfile.TemporaryDirectory(prefix="fitsgl-demo-") as tmp:
        work = Path(tmp)
        log(
            f"generating {len(DEMO_BANDS)} synthetic {size}x{size} bands "
            f"({sources} sources each, roll {rotation_deg:g}deg)"
        )
        catalog_path: Path | None = None
        bands: list[BandSpec] = []
        for slug, label, seed in DEMO_BANDS:
            image, header, cat = generate_synthetic_mosaic(
                shape=(size, size), n_sources=sources, rotation_deg=rotation_deg, seed=seed
            )
            fits_path = work / f"{slug}.fits"
            fits.PrimaryHDU(data=image, header=header).writeto(fits_path, overwrite=True)
            bands.append(BandSpec(name=slug, inputs=[fits_path], label=label))
            # Overlay markers come from the first (bluest) band's source field.
            if with_catalog and catalog_path is None:
                catalog_path = write_catalog_csv(cat, work / "catalog.csv")

        config = DatasetConfig(
            name=name,
            title="FitsGL demo",
            bands=bands,
            catalog=catalog_path,
            build=BuildSpec(),
            # RGB trilogy default view → the band-weight knobs render on load.
            viewer=ViewerSpec(mode="rgb", stretch="trilogy", **DEMO_RGB),
            config_dir=work,
        )
        return build_dataset(
            config,
            out_root,
            processes=processes,
            verify=verify,
            with_site=True,
            overwrite=False,
            on_progress=on_progress,
        )
