"""Tests for pre-tiled input assembly (placed_tiles.py) — docs/supertile-design.md slice 3.

Tiles are made by cropping one base mosaic and shifting only CRPIX, so they share a
grid (CTYPE/CRVAL/CD) and integer phase — exactly the COSMOS-Web case. Assembling
them back must reconstruct the base mosaic.
"""

from pathlib import Path

import numpy as np
import pytest
from astropy.io import fits
from astropy.wcs import WCS

from pyramid_gen.build_pyramid import StopAndAsk, build_pyramid, estimate_noise
from pyramid_gen.synthetic import generate_synthetic_mosaic


def _crop_tile(base_img, base_hdr, y0, y1, x0, x1):
    """A tile = a crop of the base, with CRPIX shifted by the crop origin (only)."""
    sub = np.ascontiguousarray(base_img[y0:y1, x0:x1])
    hdr = base_hdr.copy()
    hdr["CRPIX1"] = float(base_hdr["CRPIX1"]) - x0
    hdr["CRPIX2"] = float(base_hdr["CRPIX2"]) - y0
    return sub, hdr


def _write(path, img, hdr):
    fits.PrimaryHDU(data=img.astype(np.float32), header=hdr).writeto(path, overwrite=True)


def _read_z0(outdir, manifest):
    """Decode the (single-supertile) z=0 level of a small built pyramid."""
    z0 = manifest.levels[0]
    assert len(z0.supertiles) == 1  # small mosaic + large K -> one supertile
    with fits.open(Path(outdir) / z0.filename) as hdul:
        return np.asarray(hdul[1].data, dtype=np.float32)


def test_pretiled_assembles_and_reconstructs(tmp_path):
    base, hdr, _ = generate_synthetic_mosaic(shape=(384, 512), seed=5, nan_fraction=0.05)
    base = base.astype(np.float32)
    assert np.isnan(base).any()  # sanity: the input really has NaN padding
    # Two tiles overlapping by 80 columns: A = cols [0:300), B = cols [220:512).
    a_img, a_hdr = _crop_tile(base, hdr, 0, 384, 0, 300)
    b_img, b_hdr = _crop_tile(base, hdr, 0, 384, 220, 512)
    pa, pb = tmp_path / "tile_A.fits", tmp_path / "tile_B.fits"
    _write(pa, a_img, a_hdr)
    _write(pb, b_img, b_hdr)

    m = build_pyramid([pa, pb], output_dir=tmp_path / "out", supertile_blocks=64)

    # The virtual grid is the full base mosaic again.
    assert m.native_shape == [384, 512]
    # Global WCS restores the base grid (tiles were crops placed back).
    gw = WCS(m.levels[0].wcs)
    assert np.allclose(gw.wcs.crpix, [float(hdr["CRPIX1"]), float(hdr["CRPIX2"])])

    recon = _read_z0(tmp_path / "out", m)
    # NaN mask reconstructed exactly, finite pixels within the q=8 tolerance.
    assert np.array_equal(np.isnan(base), np.isnan(recon))
    finite = np.isfinite(base) & np.isfinite(recon)
    sigma = estimate_noise(base)
    assert np.allclose(base[finite], recon[finite], rtol=0.0, atol=sigma / 4.0)


def test_overlap_prefers_interior_tile(tmp_path):
    base, hdr, _ = generate_synthetic_mosaic(shape=(256, 512), seed=6, nan_fraction=0.0)
    base = base.astype(np.float32)
    a_img, a_hdr = _crop_tile(base, hdr, 0, 256, 0, 300)  # center at global col 149.5
    b_img, b_hdr = _crop_tile(base, hdr, 0, 256, 220, 512)  # center at global col 365.5
    # Corrupt B's LEFT EDGE (its first 10 cols = global cols 220:230) — an "edge effect".
    b_img[:, 0:10] = 1.0e6
    pa, pb = tmp_path / "tile_A.fits", tmp_path / "tile_B.fits"
    _write(pa, a_img, a_hdr)
    _write(pb, b_img, b_hdr)

    m = build_pyramid([pa, pb], output_dir=tmp_path / "out", supertile_blocks=64)
    recon = _read_z0(tmp_path / "out", m)

    # Global cols 220:230 sit on A's side of the A/B center-midline (~257.5), so the
    # interior tile A wins — B's corrupted edge is discarded.
    region = recon[:, 220:230]
    assert np.all(region < 1.0e5)  # NOT B's 1e6 corruption
    sigma = estimate_noise(base)
    assert np.allclose(base[:, 220:230], region, rtol=0.0, atol=sigma / 4.0)


def test_rejects_mismatched_grid(tmp_path):
    base, hdr, _ = generate_synthetic_mosaic(shape=(128, 128), seed=7)
    a_img, a_hdr = _crop_tile(base, hdr, 0, 128, 0, 80)
    b_img, b_hdr = _crop_tile(base, hdr, 0, 128, 48, 128)
    b_hdr["CRVAL1"] = float(b_hdr["CRVAL1"]) + 0.5  # a different reference point => different grid
    pa, pb = tmp_path / "a.fits", tmp_path / "b.fits"
    _write(pa, a_img, a_hdr)
    _write(pb, b_img, b_hdr)
    with pytest.raises(StopAndAsk, match="grid"):
        build_pyramid([pa, pb], output_dir=tmp_path / "out")


def test_rejects_subpixel_phase(tmp_path):
    base, hdr, _ = generate_synthetic_mosaic(shape=(128, 128), seed=8)
    a_img, a_hdr = _crop_tile(base, hdr, 0, 128, 0, 80)
    b_img, b_hdr = _crop_tile(base, hdr, 0, 128, 48, 128)
    # Shift B's CRPIX by a non-integer => the inter-tile offset is sub-pixel.
    b_hdr["CRPIX1"] = float(b_hdr["CRPIX1"]) - 0.5
    pa, pb = tmp_path / "a.fits", tmp_path / "b.fits"
    _write(pa, a_img, a_hdr)
    _write(pb, b_img, b_hdr)
    with pytest.raises(StopAndAsk, match="integer|phase"):
        build_pyramid([pa, pb], output_dir=tmp_path / "out")


def test_single_element_list_matches_scalar(tmp_path):
    """build_pyramid([p]) takes the single-FITS path (no assembly), same as build_pyramid(p)."""
    base, hdr, _ = generate_synthetic_mosaic(shape=(300, 300), seed=9)
    p = tmp_path / "m.fits"
    _write(p, base, hdr)
    m_scalar = build_pyramid(p, output_dir=tmp_path / "s")
    m_list = build_pyramid([p], output_dir=tmp_path / "l")
    assert m_scalar.native_shape == m_list.native_shape
    assert [lvl.shape for lvl in m_scalar.levels] == [lvl.shape for lvl in m_list.levels]
