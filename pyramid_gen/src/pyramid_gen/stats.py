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
#: Subsample target for the trilogy reductions (sigma + bright-tail percentiles).
#: Measured on native z=0 (per-pixel noise + compact peaks), strided to this cap.
TRILOGY_SAMPLE_CAP = 4_000_000


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
    with fits.open(Path(band_dir) / level.filename) as hdul:
        data = np.asarray(_image_hdu(hdul).data, dtype=np.float32)
    return histogram_dict(data, bins)


def trilogy_stats_dict(data: np.ndarray, *, sample_cap: int = TRILOGY_SAMPLE_CAP) -> dict | None:
    """Global trilogy levels for a band: robust sky mean/noise + bright-tail percentiles.

    The browser only ever sees the visible tiles, so a stable trilogy stretch needs
    a *global* noise floor and saturation level — measured here on the whole band.
    ``mean``/``sigma`` are the MAD-based robust sky level + noise (the same estimator
    as ``estimate_noise``, robust to bright sources); ``tail`` carries the bright-tail
    percentiles the saturation point lives in (beyond the 99.9th the display
    histogram is clipped to). Strided-subsampled to ``sample_cap`` so the reductions
    stay cheap on a huge native level. Returns ``None`` when there is no finite data.
    """
    finite = data[np.isfinite(data)]
    if finite.size == 0:
        return None
    if finite.size > sample_cap:
        stride = int(np.ceil(finite.size / sample_cap))
        finite = finite[::stride]
    med = float(np.median(finite))
    mad = float(np.median(np.abs(finite - med)))
    p99, p99_9, p99_99, p99_999 = (
        float(x) for x in np.percentile(finite, [99, 99.9, 99.99, 99.999])
    )
    return {
        "mean": med,
        "sigma": 1.4826 * mad,
        "tail": {
            "p99": p99,
            "p99_9": p99_9,
            "p99_99": p99_99,
            "p99_999": p99_999,
            "max": float(finite.max()),
        },
        "min": float(finite.min()),
    }


def compute_band_trilogy_stats(
    band_dir, manifest: Manifest, *, sample_cap: int = TRILOGY_SAMPLE_CAP
) -> dict | None:
    """Decode the band's native (z=0) level and reduce it to global trilogy stats.

    Uses z=0 (not a coarse level) on purpose: block-averaging lowers the measured
    noise and softens compact peaks, biasing both ``sigma`` and the saturation
    tail — and trilogy's color fidelity hinges on those. Strided-subsampled inside
    ``trilogy_stats_dict`` so the reductions stay cheap. Returns ``None`` when the
    native level has no usable finite data.
    """
    from pathlib import Path

    native = min(manifest.levels, key=lambda lvl: lvl.z)  # z=0, full resolution
    with fits.open(Path(band_dir) / native.filename) as hdul:
        data = np.asarray(_image_hdu(hdul).data, dtype=np.float32)
    return trilogy_stats_dict(data, sample_cap=sample_cap)
