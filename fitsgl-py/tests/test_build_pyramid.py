"""Tests for the pyramid builder -- the nine spec checks plus edge cases."""

import numpy as np
import pytest
from astropy.io import fits
from astropy.wcs import WCS

from fitsgl.build_pyramid import (
    StopAndAsk,
    _downsample,
    _supertile_blocks,
    build_pyramid,
    estimate_noise,
    n_levels,
)
from fitsgl.manifest import read_manifest
from fitsgl.synthetic import generate_synthetic_mosaic


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
# 2. Compression types per level (every level is display-only RICE_1 + dither)
# --------------------------------------------------------------------------- #
def test_compression_types(pyramid):
    outdir = pyramid["outdir"]
    m = pyramid["manifest"]
    for lvl in m.levels:
        hdr = _read_compression_header(outdir / lvl.filename)
        assert hdr["ZCMPTYPE"] == "RICE_1"
        assert hdr["ZQUANTIZ"] == "SUBTRACTIVE_DITHER_2"
        # ZDITHER0 (the dither seed) must be present so the browser can reverse
        # the dither; checksum-derived seeds are in the valid 1..10000 range.
        assert 1 <= hdr["ZDITHER0"] <= 10000


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
# 4. z=0 is now a lossy display level (no lossless guarantee), but its NaN mask
#    is exact and finite pixels stay within the q=8 quantization tolerance.
# --------------------------------------------------------------------------- #
def test_z0_lossy_within_tolerance(pyramid):
    m = pyramid["manifest"]
    src_img = pyramid["image"]
    back = _read_image(pyramid["outdir"] / m.levels[0].filename)
    # NaN mask identical (RICE preserves it exactly via the ZBLANK sentinel).
    assert np.array_equal(np.isnan(src_img), np.isnan(back))
    assert m.levels[0].lossless is False
    finite = np.isfinite(src_img)
    sigma = estimate_noise(src_img)
    assert np.allclose(src_img[finite], back[finite], rtol=0.0, atol=sigma / 4.0)


# --------------------------------------------------------------------------- #
# 5. every level round-trips within the q=8 tolerance
# --------------------------------------------------------------------------- #
def test_lossy_levels_within_tolerance(pyramid):
    m = pyramid["manifest"]
    src_img = pyramid["image"]
    for lvl in m.levels:
        factor = 2**lvl.z
        expected = _downsample(src_img, factor)
        back = _read_image(pyramid["outdir"] / lvl.filename)
        finite = np.isfinite(expected) & np.isfinite(back)
        sigma = estimate_noise(expected)
        # q=8 -> quantization step ~ sigma/8; per-pixel error (incl. dither
        # residual) well under sigma/4. A looser bound would still pass.
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
def test_nan_survives_z0(pyramid):
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
    # Every level is a lossy display product now (no lossless level).
    assert all(not lvl.lossless for lvl in disk.levels)


# --------------------------------------------------------------------------- #
# 9. CLI produces all files and a valid manifest
# --------------------------------------------------------------------------- #
def test_cli_end_to_end(tmp_path):
    from fitsgl.__main__ import main

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
    # z0 is a RICE_1 + SUBTRACTIVE_DITHER_2 display tile set on disk.
    hdr = _read_compression_header(outdir / manifest.levels[0].filename)
    assert hdr["ZCMPTYPE"] == "RICE_1"
    assert hdr["ZQUANTIZ"] == "SUBTRACTIVE_DITHER_2"


def test_cli_synthetic_flag(tmp_path):
    from fitsgl.__main__ import main

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


@pytest.mark.parametrize("factor", [2, 3, 4])
def test_downsample_matches_block_reduce(factor):
    """The streamed reduction must be bit-identical to astropy's whole-array
    block_reduce(np.nanmean) — including the trim and partial-NaN blocks."""
    from astropy.nddata import block_reduce

    rng = np.random.default_rng(7)
    a = rng.normal(size=(53, 47)).astype(np.float32)  # non-divisible by any factor
    a[3:5, 10:12] = np.nan  # a partial-NaN block
    a[20:24, 20:24] = np.nan  # a fully-NaN block (factor 2/4)
    expected = block_reduce(a, factor, func=np.nanmean).astype(np.float32)
    got = _downsample(a, factor)
    np.testing.assert_array_equal(got, expected)  # exact, NaN positions included


def test_downsample_streaming_matches_single_strip(monkeypatch):
    """Forcing many tiny strips (a low pixel budget) yields the same result as one
    strip — exercises the chunk-boundary logic that bounds large-mosaic memory."""
    rng = np.random.default_rng(11)
    a = rng.normal(size=(64, 40)).astype(np.float32)
    a[::7] = np.nan
    full = _downsample(a, 2)  # default huge budget → one strip
    import importlib

    mod = importlib.import_module("fitsgl.build_pyramid")  # the module (not the re-exported fn)
    monkeypatch.setattr(mod, "_DOWNSAMPLE_STRIP_PIXELS", 1)  # one output row/strip
    chunked = _downsample(a, 2)
    np.testing.assert_array_equal(chunked, full)


# --------------------------------------------------------------------------- #
# RGB registration prerequisite (M4, roadmap Risk #7): same native shape ->
# identical per-level tiling, so three same-grid bands composite under one
# shared UV; an off-by-one native shape diverges at z>=1 and must be rejected.
# --------------------------------------------------------------------------- #
def test_same_native_shape_bands_share_per_level_geometry(tmp_path):
    # 600 is non-divisible, so block_reduce trims at z>=1 -- exercise the trim.
    h, w = 600, 600
    img_a, hdr, _ = generate_synthetic_mosaic(shape=(h, w), seed=1)
    img_b, _, _ = generate_synthetic_mosaic(shape=(h, w), seed=2)  # different pixels
    pa, pb = tmp_path / "a.fits", tmp_path / "b.fits"
    fits.PrimaryHDU(data=img_a, header=hdr).writeto(pa, overwrite=True)
    fits.PrimaryHDU(data=img_b, header=hdr).writeto(pb, overwrite=True)
    ma = build_pyramid(pa, output_dir=tmp_path / "a_out")
    mb = build_pyramid(pb, output_dir=tmp_path / "b_out")
    assert ma.native_shape == mb.native_shape
    assert [lvl.shape for lvl in ma.levels] == [lvl.shape for lvl in mb.levels]
    assert [lvl.fpack_tile_count for lvl in ma.levels] == [
        lvl.fpack_tile_count for lvl in mb.levels
    ]


# --------------------------------------------------------------------------- #
# Supertiles (chunking)
# --------------------------------------------------------------------------- #
def test_supertile_partition_disjoint_cover():
    # A grid that fits in one block is the degenerate single supertile.
    assert _supertile_blocks(3, 2, 8) == [(0, 0, 3, 2)]
    # A 5×3 grid at k=2 partitions into disjoint blocks with smaller edge blocks.
    blocks = _supertile_blocks(5, 3, 2)
    covered: set[tuple[int, int]] = set()
    for tx0, ty0, snx, sny in blocks:
        for ty in range(ty0, ty0 + sny):
            for tx in range(tx0, tx0 + snx):
                assert (tx, ty) not in covered  # disjoint
                covered.add((tx, ty))
    assert covered == {(tx, ty) for ty in range(3) for tx in range(5)}  # full cover
    assert (4, 0, 1, 2) in blocks  # right edge: 1 wide, 2 tall
    assert (0, 2, 2, 1) in blocks  # bottom edge: 2 wide, 1 tall


def test_default_single_supertile_per_level(pyramid):
    """With the default block size a small mosaic emits one supertile per level,
    byte-compatible with the old layout (filename == the single supertile)."""
    for lvl in pyramid["manifest"].levels:
        assert len(lvl.supertiles) == 1
        st = lvl.supertiles[0]
        assert st.filename == lvl.filename
        assert st.tile_origin == [0, 0]
        # tile_count is [n_tiles_x, n_tiles_y] = reversed fpack_tile_count [ny, nx].
        assert st.tile_count == [lvl.fpack_tile_count[1], lvl.fpack_tile_count[0]]


def test_chunked_level_reassembles_within_tolerance(tmp_path):
    """A forcibly chunked z=0 partitions disjointly and reassembles to the source
    (within the q=8 tolerance), with the NaN mask preserved across supertiles."""
    image, header, _ = generate_synthetic_mosaic(seed=7)  # default 1024×1024
    src = tmp_path / "m.fits"
    fits.PrimaryHDU(data=image, header=header).writeto(src, overwrite=True)
    outdir = tmp_path / "out"
    m = build_pyramid(src, output_dir=outdir, supertile_blocks=2)

    z0 = m.levels[0]
    assert len(z0.supertiles) == 4  # 4×4 tile grid / 2×2 blocks
    covered: set[tuple[int, int]] = set()
    recon = np.full((1024, 1024), np.nan, dtype=np.float32)
    for st in z0.supertiles:
        tx0, ty0 = st.tile_origin
        snx, sny = st.tile_count
        assert st.filename == f"m_z0_{tx0}_{ty0}.fits.fz"
        assert (outdir / st.filename).exists()
        for ty in range(ty0, ty0 + sny):
            for tx in range(tx0, tx0 + snx):
                assert (tx, ty) not in covered
                covered.add((tx, ty))
        with fits.open(outdir / st.filename) as hdul:
            sub = np.asarray(hdul[1].data, dtype=np.float32)
        recon[ty0 * 256 : ty0 * 256 + sub.shape[0], tx0 * 256 : tx0 * 256 + sub.shape[1]] = sub
    assert covered == {(tx, ty) for ty in range(4) for tx in range(4)}

    # The level's TOTAL grid metadata is unchanged by chunking.
    assert z0.fpack_tile_count == [4, 4]
    assert z0.shape == [1024, 1024]
    # Reassembled supertiles reproduce the source within the q=8 tolerance, NaNs intact.
    assert np.array_equal(np.isnan(image), np.isnan(recon))
    finite = np.isfinite(image) & np.isfinite(recon)
    sigma = estimate_noise(image)
    assert np.allclose(image[finite], recon[finite], rtol=0.0, atol=sigma / 4.0)


def test_size_budget_over_limit_raises(tmp_path):
    """A supertile exceeding the byte budget is a build error naming the knob."""
    # 256×256 → a single level (z=0), so this runs inline (no worker pool).
    image, header, _ = generate_synthetic_mosaic(shape=(256, 256), seed=11)
    src = tmp_path / "m.fits"
    fits.PrimaryHDU(data=image, header=header).writeto(src, overwrite=True)
    with pytest.raises(RuntimeError, match="supertile_blocks"):
        build_pyramid(src, output_dir=tmp_path / "out", size_budget_bytes=1)


def test_supertile_blocks_must_be_positive(tmp_path):
    image, header, _ = generate_synthetic_mosaic(shape=(256, 256), seed=12)
    src = tmp_path / "m.fits"
    fits.PrimaryHDU(data=image, header=header).writeto(src, overwrite=True)
    with pytest.raises(ValueError, match="supertile_blocks"):
        build_pyramid(src, output_dir=tmp_path / "out", supertile_blocks=0)


def test_off_by_one_native_shape_diverges_per_level(tmp_path):
    img_a, hdr_a, _ = generate_synthetic_mosaic(shape=(1024, 1024), seed=1)
    img_b, hdr_b, _ = generate_synthetic_mosaic(shape=(1023, 1024), seed=1)
    pa, pb = tmp_path / "a.fits", tmp_path / "b.fits"
    fits.PrimaryHDU(data=img_a, header=hdr_a).writeto(pa, overwrite=True)
    fits.PrimaryHDU(data=img_b, header=hdr_b).writeto(pb, overwrite=True)
    ma = build_pyramid(pa, output_dir=tmp_path / "a_out")
    mb = build_pyramid(pb, output_dir=tmp_path / "b_out")
    assert ma.native_shape != mb.native_shape
    # Off-by-one native height trims to different per-level shapes -- which is why
    # composite compatibility requires EXACT shape, not just matching WCS.
    assert [lvl.shape for lvl in ma.levels] != [lvl.shape for lvl in mb.levels]
