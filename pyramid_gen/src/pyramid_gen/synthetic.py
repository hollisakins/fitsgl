"""Synthetic test mosaic generator.

Produces a small TAN-projected FITS mosaic with Gaussian PSF sources, a flat
background, low Gaussian noise, and a sprinkling of NaN blobs -- enough to
exercise every code path in the pyramid builder without needing real data.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from astropy.io import fits

# COSMOS field reference, matching the survey context this tool targets.
_COSMOS_RA = 150.0
_COSMOS_DEC = 2.2

# Gaussian FWHM -> sigma conversion factor.
_FWHM_TO_SIGMA = 1.0 / (2.0 * np.sqrt(2.0 * np.log(2.0)))


def _tan_header(shape: tuple[int, int], pixel_scale_arcsec: float) -> fits.Header:
    """Build a minimal valid TAN WCS header for the given image shape."""
    h, w = shape
    scale_deg = pixel_scale_arcsec / 3600.0
    hdr = fits.Header()
    hdr["WCSAXES"] = 2
    hdr["CTYPE1"] = "RA---TAN"
    hdr["CTYPE2"] = "DEC--TAN"
    hdr["CUNIT1"] = "deg"
    hdr["CUNIT2"] = "deg"
    # Reference pixel at image center (FITS 1-indexed).
    hdr["CRPIX1"] = (w + 1) / 2.0
    hdr["CRPIX2"] = (h + 1) / 2.0
    hdr["CRVAL1"] = _COSMOS_RA
    hdr["CRVAL2"] = _COSMOS_DEC
    # RA increases to the left (east), so CD1_1 is negative.
    hdr["CD1_1"] = -scale_deg
    hdr["CD1_2"] = 0.0
    hdr["CD2_1"] = 0.0
    hdr["CD2_2"] = scale_deg
    hdr["RADESYS"] = "ICRS"
    return hdr


def _add_gaussian(image: np.ndarray, x: float, y: float, flux: float, sigma: float) -> None:
    """Add a single 2D Gaussian PSF source into image in place.

    x, y are 0-indexed pixel coordinates (x=column, y=row). The source is
    rendered over a local box for efficiency.
    """
    h, w = image.shape
    radius = int(np.ceil(5.0 * sigma))
    x0, x1 = max(0, int(x) - radius), min(w, int(x) + radius + 1)
    y0, y1 = max(0, int(y) - radius), min(h, int(y) + radius + 1)
    if x0 >= x1 or y0 >= y1:
        return
    yy, xx = np.mgrid[y0:y1, x0:x1]
    r2 = (xx - x) ** 2 + (yy - y) ** 2
    # Normalized 2D Gaussian scaled to carry total `flux`.
    amp = flux / (2.0 * np.pi * sigma**2)
    image[y0:y1, x0:x1] += amp * np.exp(-r2 / (2.0 * sigma**2))


def _add_nan_blobs(
    image: np.ndarray, nan_fraction: float, rng: np.random.Generator
) -> None:
    """Punch out roughly `nan_fraction` of pixels as connected NaN blobs."""
    if nan_fraction <= 0:
        return
    h, w = image.shape
    target = int(round(nan_fraction * h * w))
    if target <= 0:
        return
    placed = 0
    # Square blobs a handful of pixels across -- large enough that some survive
    # downsampling as fully-NaN tiles for the NaN round-trip test.
    while placed < target:
        bh = int(rng.integers(3, 9))
        bw = int(rng.integers(3, 9))
        y0 = int(rng.integers(0, max(1, h - bh)))
        x0 = int(rng.integers(0, max(1, w - bw)))
        image[y0 : y0 + bh, x0 : x0 + bw] = np.nan
        placed += bh * bw


def generate_synthetic_mosaic(
    shape: tuple[int, int] = (1024, 1024),
    pixel_scale_arcsec: float = 0.03,
    n_sources: int = 50,
    seed: int = 42,
    nan_fraction: float = 0.01,
) -> tuple[np.ndarray, fits.Header, pd.DataFrame]:
    """Generate a synthetic TAN-projected mosaic.

    Returns
    -------
    (image, header_with_TAN_WCS, source_catalog)
        image : float32 ndarray of shape `shape`
        header : FITS header carrying a valid TAN WCS
        catalog : DataFrame with columns [x, y, ra, dec, flux]
    """
    from astropy.wcs import WCS

    h, w = shape
    rng = np.random.default_rng(seed)

    # Flat background plus low Gaussian noise.
    background = 1.0
    noise_sigma = 0.05
    image = (background + rng.normal(0.0, noise_sigma, size=shape)).astype(np.float32)

    # Random PSF sources.
    sigma = 2.5 * _FWHM_TO_SIGMA  # FWHM = 2.5 px
    xs = rng.uniform(0, w - 1, size=n_sources)
    ys = rng.uniform(0, h - 1, size=n_sources)
    fluxes = rng.uniform(5.0, 200.0, size=n_sources)
    for x, y, flux in zip(xs, ys, fluxes):
        _add_gaussian(image, x, y, flux, sigma)

    hdr = _tan_header(shape, pixel_scale_arcsec)
    wcs = WCS(hdr)
    ra, dec = wcs.all_pix2world(xs, ys, 0)

    catalog = pd.DataFrame(
        {"x": xs, "y": ys, "ra": ra, "dec": dec, "flux": fluxes}
    )

    # NaN blobs go in last so they win over any source flux underneath.
    _add_nan_blobs(image, nan_fraction, rng)

    # Stamp basic shape keywords for downstream consumers.
    hdr["NAXIS"] = 2
    hdr["NAXIS1"] = w
    hdr["NAXIS2"] = h

    return image, hdr, catalog
