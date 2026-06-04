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

import math

import numpy as np
from astropy.io import fits

from .manifest import LevelInfo, Manifest

#: Decode at most this many pixels for the histogram (bounds cost on huge mosaics).
STATS_PIXEL_CAP = 2_000_000
#: Histogram bins (matches the viewer's default `visibleHistogram` bin count).
HISTOGRAM_BINS = 128
#: Accumulate at most this many NATIVE-resolution finite samples across all supertiles
#: for the trilogy stretch stats. Native (z=0) resolution is required — block-averaged
#: coarse levels bias the noise sigma down and clip the bright tail — but a few million
#: samples already give a stable median/MAD + bright-tail percentiles while holding far
#: fewer pixels than the full native level (which can be tens of GB on a large mosaic).
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


def trilogy_stats_dict(sample: np.ndarray) -> dict | None:
    """Robust global stats for the trilogy stretch from an accumulated 1-D sample.

    Returns ``{"mean", "sigma", "tail": {p99, p99_9, p99_99, p99_999}}`` where
    ``mean`` is the median (robust sky level) and ``sigma = 1.4826 * MAD`` (the same
    estimator as ``build_pyramid.estimate_noise``). The bright-tail percentiles carry
    the saturation point (beyond the 99.9th the display histogram is clipped to).
    Returns ``None`` when the sample has no finite values OR is degenerate (MAD == 0,
    a constant band), mirroring ``histogram_dict`` so a flat band never ships
    ``sigma == 0``.
    """
    finite = sample[np.isfinite(sample)]
    if finite.size == 0:
        return None
    # One pass for every order statistic: the median (p50) doubles as the robust sky
    # level and the MAD centre; p99..p99.999 are the bright-tail saturation anchors.
    p50, p99, p99_9, p99_99, p99_999 = (
        float(x) for x in np.percentile(finite, [50.0, 99.0, 99.9, 99.99, 99.999])
    )
    sigma = 1.4826 * float(np.median(np.abs(finite - p50)))
    if not (sigma > 0.0):  # constant / degenerate band → no usable stretch
        return None
    return {
        "mean": p50,
        "sigma": sigma,
        "tail": {"p99": p99, "p99_9": p99_9, "p99_99": p99_99, "p99_999": p99_999},
    }


def compute_band_trilogy_stats(
    band_dir, manifest: Manifest, *, sample_cap: int = TRILOGY_SAMPLE_CAP
) -> dict | None:
    """Global trilogy-stretch stats from a band's NATIVE (z=0) level.

    Reads native resolution on purpose — a coarse, block-averaged level lowers the
    measured noise and softens compact peaks, and trilogy's color fidelity hinges on
    both. But it never materializes the whole level: each supertile (already size-
    bounded by the build's CDN object cap) is decoded once and strided-subsampled to a
    per-tile quota, so the accumulated sample stays ≈ ``sample_cap`` and peak memory is
    one decoded supertile + the capped sample, not the full native array. Returns the
    trilogy dict, or ``None`` if the native level has no usable finite / non-constant
    data (see :func:`trilogy_stats_dict`).
    """
    from pathlib import Path

    native = min(manifest.levels, key=lambda lvl: lvl.z)  # z=0, full resolution
    quota = max(1, math.ceil(sample_cap / max(1, len(native.supertiles))))
    samples: list[np.ndarray] = []
    for st in native.supertiles:
        with fits.open(Path(band_dir) / st.filename) as hdul:
            arr = np.asarray(_image_hdu(hdul).data, dtype=np.float32).reshape(-1)
        finite = arr[np.isfinite(arr)]
        del arr  # free the full supertile decode before reading the next one
        if finite.size == 0:
            continue
        if finite.size > quota:
            finite = finite[:: finite.size // quota]  # stride down to ≈ quota
        samples.append(np.ascontiguousarray(finite))
    if not samples:
        return None
    sample = samples[0] if len(samples) == 1 else np.concatenate(samples)
    return trilogy_stats_dict(sample)
