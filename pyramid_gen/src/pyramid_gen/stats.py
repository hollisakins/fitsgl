"""Pre-computed per-band display statistics for the viewer's stretch panel.

The control panel shows a histogram of the data behind the black/white-point
sliders. Computing it live in the browser (scan the visible tiles on the first
frame) is fragile on a large, HTTP-served, NaN-padded mosaic — a bad first frame
leaves the panel stuck. So the producer computes it once here and ships it in
``fitsgl.json`` (``band.stats.histogram``); the viewer just displays it.

It's a display aid, not authoritative data, so it's computed over a *representative
coarse level* (the finest level under a pixel cap — cheap, and ≈ what fit-to-image
first shows), over a robust ``[p0.1, p99.9]`` domain so hot pixels don't flatten it.
"""

from __future__ import annotations

import numpy as np
from astropy.io import fits

from .manifest import LevelInfo, Manifest

#: Decode at most this many pixels for the histogram (bounds cost on huge mosaics).
STATS_PIXEL_CAP = 2_000_000
#: Histogram bins (matches the viewer's default `visibleHistogram` bin count).
HISTOGRAM_BINS = 128


def _choose_level(manifest: Manifest, pixel_cap: int) -> LevelInfo:
    """The finest level whose pixel count is within ``pixel_cap`` (coarsest if none)."""
    by_z = sorted(manifest.levels, key=lambda lvl: lvl.z)
    for lvl in by_z:
        if lvl.shape[0] * lvl.shape[1] <= pixel_cap:
            return lvl
    return by_z[-1]  # all levels exceed the cap (unlikely): use the coarsest


def _image_hdu(hdul: fits.HDUList) -> fits.hdu.base.ExtensionHDU:
    """The 2D image HDU of an fpacked file (``.shape`` is header-only, no decode)."""
    for hdu in hdul:
        shape = getattr(hdu, "shape", None)
        if isinstance(shape, tuple) and len(shape) == 2:
            return hdu
    raise ValueError("no 2D image HDU in fpack file")


def histogram_dict(data: np.ndarray, bins: int = HISTOGRAM_BINS) -> dict | None:
    """A ``{counts, lo, hi}`` histogram over the finite data's robust domain.

    Returns ``None`` when there is no finite data or it is degenerate (single
    value), so the caller simply omits ``stats`` and the viewer falls back to its
    live scan for that band.
    """
    finite = data[np.isfinite(data)]
    if finite.size == 0:
        return None
    lo, hi = (float(x) for x in np.percentile(finite, [0.1, 99.9]))
    if not (hi > lo):  # flat percentile band — widen to the full finite range
        lo, hi = float(finite.min()), float(finite.max())
        if not (hi > lo):
            return None
    counts, _ = np.histogram(finite, bins=bins, range=(lo, hi))
    return {"counts": [int(c) for c in counts], "lo": lo, "hi": hi}


def compute_band_histogram(
    band_dir, manifest: Manifest, *, pixel_cap: int = STATS_PIXEL_CAP, bins: int = HISTOGRAM_BINS
) -> dict | None:
    """Decode a representative coarse level of a built band and histogram it.

    ``band_dir`` is the band's output directory (holding the ``.fits.fz`` levels).
    Returns the histogram dict, or ``None`` if the level has no usable finite data.
    """
    from pathlib import Path

    level = _choose_level(manifest, pixel_cap)
    # A coarse level (≤ pixel_cap) is normally one supertile, but read every supertile
    # so the histogram is correct even if the chosen level happens to be chunked. The
    # histogram is over pixel VALUES, so spatial layout (origins) is irrelevant — just
    # concatenate the finite samples.
    values: list[np.ndarray] = []
    for st in level.supertiles:
        with fits.open(Path(band_dir) / st.filename) as hdul:
            arr = np.asarray(_image_hdu(hdul).data, dtype=np.float32).reshape(-1)
        values.append(arr[np.isfinite(arr)])
    data = values[0] if len(values) == 1 else np.concatenate(values)
    return histogram_dict(data, bins)
