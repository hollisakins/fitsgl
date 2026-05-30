"""Tests for the pyramid builder -- the nine spec checks plus edge cases."""

import numpy as np
import pytest
from astropy.io import fits
from astropy.wcs import WCS

from pyramid_gen.build_pyramid import (
    StopAndAsk,
    _downsample,
    build_pyramid,
    estimate_noise,
    n_levels,
)
from pyramid_gen.manifest import read_manifest
from pyramid_gen.synthetic import generate_synthetic_mosaic


# --------------------------------------------------------------------------- #
# Shared fixture: build one 1024x1024 pyramid for the whole module.
# --------------------------------------------------------------------------- #
@pytest.fixture(scope="module")
def pyramid(tmp_path_factory):
    d = tmp_path_factory.mktemp("pyr")
    image, header, catalog = generate_synthetic_mosaic(seed=42)
    src = d / "mosaic.fits"
    fits.PrimaryHDU(data=image, header=header).writeto(src, overwrite=True)
    manifest = build_pyramid(src)
    outdir = d / "mosaic_pyramid"
    return {
        "src": src,
        "outdir": outdir,
        "manifest": manifest,
        "image": image,
        "header": header,
        "catalog": catalog,
    }


def _read_image(path):
    with fits.open(path) as hdul:
        return np.asarray(hdul[1].data)


def _read_compression_header(path):
    """Return the compressed bintable header (ZCMPTYPE / ZTILEn live here)."""
    with fits.open(path, disable_image_compression=True) as hdul:
        return hdul[1].header.copy()


# --------------------------------------------------------------------------- #
# 1. Level count
# --------------------------------------------------------------------------- #
def test_three_levels_for_1024(pyramid):
    m = pyramid["manifest"]
    assert m.n_levels == 2
    assert [lvl.z for lvl in m.levels] == [0, 1, 2]
    for lvl in m.levels:
        assert (pyramid["outdir"] / lvl.filename).exists()


def test_n_levels_formula():
    assert n_levels((1024, 1024)) == 2
    assert n_levels((256, 256)) == 0  # already a single tile
    assert n_levels((257, 100)) == 1
    assert n_levels((4096, 4096)) == 4
    assert n_levels((100, 5000)) == 5  # driven by the larger dimension


# --------------------------------------------------------------------------- #
# 2. Compression types per level
# --------------------------------------------------------------------------- #
def test_compression_types(pyramid):
    outdir = pyramid["outdir"]
    m = pyramid["manifest"]
    z0 = _read_compression_header(outdir / m.levels[0].filename)
    assert z0["ZCMPTYPE"] == "GZIP_2"
    for lvl in m.levels[1:]:
        hdr = _read_compression_header(outdir / lvl.filename)
        assert hdr["ZCMPTYPE"] == "RICE_1"


# --------------------------------------------------------------------------- #
# 3. Tile size 256 on every level
# --------------------------------------------------------------------------- #
def test_tile_size_256(pyramid):
    outdir = pyramid["outdir"]
    for lvl in pyramid["manifest"].levels:
        hdr = _read_compression_header(outdir / lvl.filename)
        assert hdr["ZTILE1"] == 256
        assert hdr["ZTILE2"] == 256


# --------------------------------------------------------------------------- #
# 4. z=0 lossless round-trip (the science-distribution guarantee)
# --------------------------------------------------------------------------- #
def test_z0_lossless(pyramid):
    m = pyramid["manifest"]
    src_img = pyramid["image"]
    back = _read_image(pyramid["outdir"] / m.levels[0].filename)
    # NaN mask identical.
    assert np.array_equal(np.isnan(src_img), np.isnan(back))
    # Finite pixels bit-for-bit identical.
    finite = np.isfinite(src_img)
    assert np.array_equal(src_img[finite], back[finite])


# --------------------------------------------------------------------------- #
# 5. z>0 round-trip within q=16 tolerance
# --------------------------------------------------------------------------- #
def test_lossy_levels_within_tolerance(pyramid):
    m = pyramid["manifest"]
    src_img = pyramid["image"]
    for lvl in m.levels[1:]:
        factor = 2**lvl.z
        expected = _downsample(src_img, factor)
        back = _read_image(pyramid["outdir"] / lvl.filename)
        finite = np.isfinite(expected) & np.isfinite(back)
        sigma = estimate_noise(expected)
        # q=16 -> quantization step ~ sigma/16; per-pixel error well under
        # sigma/4. A far looser bound here would still pass; this stays tight.
        assert np.allclose(
            expected[finite], back[finite], rtol=0.0, atol=sigma / 4.0
        )


# --------------------------------------------------------------------------- #
# 6. WCS at each level projects to the expected sky coords
# --------------------------------------------------------------------------- #
def test_wcs_projection_per_level(pyramid):
    m = pyramid["manifest"]
    native_wcs = WCS(pyramid["header"])
    # Pixels (0-indexed) in the downsampled frame to probe.
    probes = [(0, 0), (10, 25), (100, 60)]
    for lvl in m.levels:
        factor = 2**lvl.z
        level_wcs = WCS(lvl.wcs)
        for (i, j) in probes:  # i=row(y), j=col(x)
            # Center of downsampled pixel (i,j) maps to native block center.
            nx = factor * j + (factor - 1) / 2.0
            ny = factor * i + (factor - 1) / 2.0
            sky_native = native_wcs.pixel_to_world(nx, ny)
            sky_level = level_wcs.pixel_to_world(j, i)
            sep = sky_native.separation(sky_level).arcsec
            assert sep < 1e-3, f"z={lvl.z} pixel ({i},{j}) sep={sep:.2e}\""


# --------------------------------------------------------------------------- #
# 7. NaN pixels survive through both compression paths
# --------------------------------------------------------------------------- #
def test_nan_survives_lossless_path(pyramid):
    m = pyramid["manifest"]
    src_img = pyramid["image"]
    assert np.isnan(src_img).any()  # sanity: input actually has NaNs
    back = _read_image(pyramid["outdir"] / m.levels[0].filename)
    assert np.array_equal(np.isnan(src_img), np.isnan(back))


def test_nan_survives_lossy_path(pyramid):
    m = pyramid["manifest"]
    src_img = pyramid["image"]
    for lvl in m.levels[1:]:
        expected = _downsample(src_img, 2**lvl.z)
        assert np.isnan(expected).any()  # fully-NaN blocks survive downsampling
        back = _read_image(pyramid["outdir"] / lvl.filename)
        # NaN mask preserved exactly through RICE_1 (no finite<->NaN leakage).
        assert np.array_equal(np.isnan(expected), np.isnan(back))


# --------------------------------------------------------------------------- #
# 8. Manifest compression field matches the file's actual ZCMPTYPE
# --------------------------------------------------------------------------- #
def test_manifest_compression_matches_file(pyramid):
    outdir = pyramid["outdir"]
    for lvl in pyramid["manifest"].levels:
        hdr = _read_compression_header(outdir / lvl.filename)
        assert lvl.compression == hdr["ZCMPTYPE"]


def test_manifest_on_disk_matches_returned(pyramid):
    disk = read_manifest(pyramid["outdir"] / "manifest.json")
    assert disk.to_dict() == pyramid["manifest"].to_dict()
    # z=0 marked lossless, z>0 lossy.
    assert disk.levels[0].lossless is True
    assert all(not lvl.lossless for lvl in disk.levels[1:])


# --------------------------------------------------------------------------- #
# 9. CLI produces all files and a valid manifest
# --------------------------------------------------------------------------- #
def test_cli_end_to_end(tmp_path):
    from pyramid_gen.__main__ import main

    image, header, _cat = generate_synthetic_mosaic(seed=3)
    src = tmp_path / "cli_mosaic.fits"
    fits.PrimaryHDU(data=image, header=header).writeto(src, overwrite=True)

    rc = main([str(src)])
    assert rc == 0

    outdir = tmp_path / "cli_mosaic_pyramid"
    manifest = read_manifest(outdir / "manifest.json")
    assert manifest.n_levels == 2
    for lvl in manifest.levels:
        assert (outdir / lvl.filename).exists()
    # z0 is GZIP_2 lossless on disk.
    hdr = _read_compression_header(outdir / manifest.levels[0].filename)
    assert hdr["ZCMPTYPE"] == "GZIP_2"


def test_cli_synthetic_flag(tmp_path):
    from pyramid_gen.__main__ import main

    synth = tmp_path / "synth.fits"
    rc = main(["--synthetic", str(synth), "-o", str(tmp_path / "out")])
    assert rc == 0
    assert synth.exists()
    manifest = read_manifest(tmp_path / "out" / "manifest.json")
    assert len(manifest.levels) == manifest.n_levels + 1


# --------------------------------------------------------------------------- #
# Edge cases: the "stop and ask" inputs.
# --------------------------------------------------------------------------- #
def test_rejects_3d_input(tmp_path):
    cube = np.zeros((3, 64, 64), dtype=np.float32)
    p = tmp_path / "cube.fits"
    fits.PrimaryHDU(data=cube).writeto(p, overwrite=True)
    with pytest.raises(StopAndAsk):
        build_pyramid(p)


def test_rejects_multiple_image_hdus(tmp_path):
    img = np.zeros((64, 64), dtype=np.float32)
    hdul = fits.HDUList(
        [fits.PrimaryHDU(), fits.ImageHDU(data=img), fits.ImageHDU(data=img)]
    )
    p = tmp_path / "multi.fits"
    hdul.writeto(p, overwrite=True)
    with pytest.raises(StopAndAsk):
        build_pyramid(p)


def test_rejects_sip_distortion(tmp_path):
    image, header, _cat = generate_synthetic_mosaic(shape=(128, 128))
    # Inject a SIP marker.
    header["CTYPE1"] = "RA---TAN-SIP"
    header["CTYPE2"] = "DEC--TAN-SIP"
    header["A_ORDER"] = 2
    header["B_ORDER"] = 2
    header["A_2_0"] = 1e-5
    header["B_0_2"] = 1e-5
    p = tmp_path / "sip.fits"
    fits.PrimaryHDU(data=image, header=header).writeto(p, overwrite=True)
    with pytest.raises(StopAndAsk):
        build_pyramid(p)


# --------------------------------------------------------------------------- #
# Downsample geometry sanity
# --------------------------------------------------------------------------- #
def test_downsample_trims_non_divisible():
    a = np.ones((10, 10), dtype=np.float32)
    r = _downsample(a, 4)  # 10 -> 2 (trailing 2 trimmed)
    assert r.shape == (2, 2)


def test_downsample_preserves_all_nan_block():
    a = np.ones((4, 4), dtype=np.float32)
    a[:] = np.nan
    r = _downsample(a, 4)
    assert r.shape == (1, 1)
    assert np.isnan(r[0, 0])
