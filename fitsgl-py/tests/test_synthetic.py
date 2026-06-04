"""Tests for the synthetic mosaic generator."""

import numpy as np
import pandas as pd
from astropy.wcs import WCS

from fitsgl.synthetic import generate_synthetic_mosaic


def test_shape_and_dtype():
    img, hdr, cat = generate_synthetic_mosaic(shape=(256, 384))
    assert img.shape == (256, 384)
    assert img.dtype == np.float32


def test_tan_wcs_header():
    _img, hdr, _cat = generate_synthetic_mosaic()
    assert hdr["CTYPE1"] == "RA---TAN"
    assert hdr["CTYPE2"] == "DEC--TAN"
    # Reference value at the COSMOS field center.
    assert hdr["CRVAL1"] == 150.0
    assert hdr["CRVAL2"] == 2.2
    wcs = WCS(hdr)
    assert wcs.has_celestial


def test_catalog_columns_and_wcs_consistency():
    img, hdr, cat = generate_synthetic_mosaic(n_sources=20)
    assert isinstance(cat, pd.DataFrame)
    assert list(cat.columns) == ["x", "y", "ra", "dec", "flux"]
    assert len(cat) == 20
    # Catalog ra/dec must be the WCS projection of its x/y.
    wcs = WCS(hdr)
    ra, dec = wcs.all_pix2world(cat["x"].to_numpy(), cat["y"].to_numpy(), 0)
    np.testing.assert_allclose(ra, cat["ra"].to_numpy(), rtol=0, atol=1e-9)
    np.testing.assert_allclose(dec, cat["dec"].to_numpy(), rtol=0, atol=1e-9)


def test_sources_present_above_background():
    img, _hdr, _cat = generate_synthetic_mosaic(n_sources=50, nan_fraction=0.0)
    # Bright PSF sources should rise well above the ~1.0 background.
    assert np.nanmax(img) > 5.0


def test_nan_fraction_and_blobs():
    img, _hdr, _cat = generate_synthetic_mosaic(nan_fraction=0.02, seed=1)
    frac = np.isnan(img).mean()
    # Roughly the requested fraction (connected blobs overlap, so allow slack).
    assert 0.005 < frac < 0.05


def test_no_nan_when_fraction_zero():
    img, _hdr, _cat = generate_synthetic_mosaic(nan_fraction=0.0)
    assert not np.isnan(img).any()


def test_reproducible_with_seed():
    a, _, _ = generate_synthetic_mosaic(seed=7)
    b, _, _ = generate_synthetic_mosaic(seed=7)
    assert np.array_equal(np.nan_to_num(a), np.nan_to_num(b))
    assert np.array_equal(np.isnan(a), np.isnan(b))
