"""Read-side / server-cutout API tests (issue #17).

Covers three modules against a real, multi-supertile pyramid built from the
synthetic mosaic:

* ``fitsgl.tiles`` — level selection ("idealZoom"), supertile resolution, tile
  coverage geometry (pure, no astropy);
* ``fitsgl.fpack_index`` — fpack byte-range addressing, validated *byte-for-byte*
  against astropy's own extraction of each tile's compressed bytes;
* ``fitsgl.cutout`` — the astropy-backed ``plan_cutout`` planner, validated
  against astropy's forward WCS projection.
"""

import math

import numpy as np
import pytest
from astropy.io import fits
from astropy.wcs import WCS

from fitsgl.build_pyramid import build_pyramid
from fitsgl.cutout import CutoutPlan, plan_cutout
from fitsgl.fpack_index import (
    ByteRange,
    IncompleteHeaderError,
    SupertileIndex,
    coalesce_ranges,
)
from fitsgl.manifest import LevelInfo, Manifest, SupertileInfo, read_manifest
from fitsgl.synthetic import generate_synthetic_mosaic
from fitsgl.tiles import (
    PixelBBox,
    level_tile_grid,
    pixel_to_tile,
    resolve_supertile,
    select_level,
    select_level_index,
    tile_pixel_bounds,
    tiles_for_pixel_bbox,
)


# --------------------------------------------------------------------------- #
# Shared fixture: a rotated, multi-supertile 1024x1024 pyramid.
# --------------------------------------------------------------------------- #
@pytest.fixture(scope="module")
def pyramid(tmp_path_factory):
    d = tmp_path_factory.mktemp("reader_pyr")
    # rotation exercises the WCS projection; supertile_blocks=2 forces the z=0
    # level (4x4 tiles) to split into a 2x2 grid of supertiles.
    image, header, _ = generate_synthetic_mosaic(seed=7, rotation_deg=15.0)
    src = d / "mosaic.fits"
    fits.PrimaryHDU(data=image, header=header).writeto(src, overwrite=True)
    manifest = build_pyramid(src, supertile_blocks=2, processes=1)
    return {"outdir": d / "mosaic_pyramid", "manifest": manifest, "header": header}


@pytest.fixture(scope="module")
def manifest(pyramid):
    # Round-trip through disk to exercise the same path a consumer uses.
    return read_manifest(pyramid["outdir"] / "manifest.json")


@pytest.fixture(scope="module")
def odd_pyramid(tmp_path_factory):
    """A deliberately awkward pyramid: non-square (H!=W), a non-256 fpack tile
    size, and multiple supertiles — so axis-order swaps, partial-edge tiles, and
    the manifest tile-size plumbing are all actually exercised (the square,
    256-multiple `pyramid` fixture hides them)."""
    d = tmp_path_factory.mktemp("reader_odd")
    image, header, _ = generate_synthetic_mosaic(shape=(360, 600), seed=11, rotation_deg=10.0)
    src = d / "odd.fits"
    fits.PrimaryHDU(data=image, header=header).writeto(src, overwrite=True)
    manifest = build_pyramid(src, tile_size=128, supertile_blocks=3, processes=1)
    return {"outdir": d / "odd_pyramid", "manifest": manifest}


@pytest.fixture(scope="module")
def odd_manifest(odd_pyramid):
    return read_manifest(odd_pyramid["outdir"] / "manifest.json")


# --------------------------------------------------------------------------- #
# tiles.py — level selection ("idealZoom")
# --------------------------------------------------------------------------- #
def test_level_scales_double_per_level(manifest):
    scales = [lvl.pixel_scale_arcsec for lvl in sorted(manifest.levels, key=lambda lv: lv.z)]
    assert scales[0] == pytest.approx(0.03, rel=1e-3)
    for a, b in zip(scales, scales[1:]):
        assert b == pytest.approx(2 * a, rel=1e-3)


def test_select_level_nearest_matches_viewer(manifest):
    # z0=0.03, z1=0.06, z2=0.12 arcsec/px.
    assert select_level_index(manifest, 0.03) == 0
    assert select_level_index(manifest, 0.06) == 1
    assert select_level_index(manifest, 0.12) == 2
    # 0.05 is closer to 0.06 than 0.03 in log space -> z1.
    assert select_level_index(manifest, 0.05) == 1
    # 0.043 (geometric mean of 0.03 and 0.06) sits ~on the boundary; still valid.
    assert select_level_index(manifest, 0.041) == 0


def test_select_level_clamps_out_of_range(manifest):
    assert select_level_index(manifest, 0.001) == 0  # finer than native -> finest
    assert select_level_index(manifest, 10.0) == 2  # coarser than deepest -> deepest


def test_select_level_rounding_finer_never_upsamples(manifest):
    # finer: coarsest level still at least as fine as the request.
    assert select_level_index(manifest, 0.05, rounding="finer") == 0  # 0.03 <= 0.05
    assert select_level_index(manifest, 0.11, rounding="finer") == 1  # 0.06 <= 0.11
    assert select_level_index(manifest, 0.20, rounding="finer") == 2
    assert select_level_index(manifest, 0.01, rounding="finer") == 0  # nothing finer -> finest


def test_select_level_rounding_coarser(manifest):
    assert select_level_index(manifest, 0.05, rounding="coarser") == 1  # 0.06 >= 0.05
    assert select_level_index(manifest, 0.07, rounding="coarser") == 2  # 0.12 >= 0.07
    assert select_level_index(manifest, 0.20, rounding="coarser") == 2  # nothing coarser -> deepest


def test_select_level_returns_levelinfo(manifest):
    lvl = select_level(manifest, 0.06)
    assert lvl.z == 1
    assert lvl.pixel_scale_arcsec == pytest.approx(0.06, rel=1e-3)


def test_select_level_rejects_bad_scale(manifest):
    with pytest.raises(ValueError):
        select_level_index(manifest, 0.0)
    with pytest.raises(ValueError):
        select_level_index(manifest, -1.0)
    with pytest.raises(ValueError):
        select_level_index(manifest, 0.05, rounding="sideways")  # type: ignore[arg-type]


# --------------------------------------------------------------------------- #
# tiles.py — supertile resolution
# --------------------------------------------------------------------------- #
def test_z0_is_multi_supertile(manifest):
    z0 = next(lv for lv in manifest.levels if lv.z == 0)
    assert len(z0.supertiles) == 4  # 4x4 tiles / (2x2 blocks) = 2x2 supertiles
    n_tx, n_ty = level_tile_grid(z0)
    assert (n_tx, n_ty) == (4, 4)


def test_resolve_supertile_covers_grid_disjointly(manifest):
    """Every in-grid tile resolves to exactly one supertile, with correct local coords."""
    for lvl in manifest.levels:
        n_tx, n_ty = level_tile_grid(lvl)
        for ty in range(n_ty):
            for tx in range(n_tx):
                matches = [
                    (i, st)
                    for i, st in enumerate(lvl.supertiles)
                    if st.tile_origin[0] <= tx < st.tile_origin[0] + st.tile_count[0]
                    and st.tile_origin[1] <= ty < st.tile_origin[1] + st.tile_count[1]
                ]
                assert len(matches) == 1, f"tile ({tx},{ty}) at z={lvl.z} matched {len(matches)} supertiles"
                m = resolve_supertile(lvl, tx, ty)
                assert m is not None
                idx, st = matches[0]
                assert m.index == idx
                assert m.supertile.filename == st.filename
                assert m.local_x == tx - st.tile_origin[0]
                assert m.local_y == ty - st.tile_origin[1]


def test_resolve_supertile_out_of_grid_is_none(manifest):
    z0 = next(lv for lv in manifest.levels if lv.z == 0)
    n_tx, n_ty = level_tile_grid(z0)
    assert resolve_supertile(z0, n_tx, 0) is None
    assert resolve_supertile(z0, 0, n_ty) is None
    assert resolve_supertile(z0, -1, 0) is None


def test_resolve_supertile_gap_returns_none():
    """A tile in a hole left by a dropped all-NaN supertile resolves to None."""
    lvl = LevelInfo(
        z=0,
        filename="a.fits.fz",
        compression="RICE_1",
        lossless=False,
        shape=[512, 512],
        fpack_tile_count=[2, 2],  # 2x2 tiles
        pixel_scale_arcsec=0.03,
        wcs={},
        supertiles=[
            # only the left column is present; (1, *) is a gap
            SupertileInfo(filename="a.fits.fz", tile_origin=[0, 0], tile_count=[1, 2]),
        ],
    )
    assert resolve_supertile(lvl, 0, 0) is not None
    assert resolve_supertile(lvl, 0, 1) is not None
    assert resolve_supertile(lvl, 1, 0) is None  # gap
    assert resolve_supertile(lvl, 1, 1) is None  # gap


# --------------------------------------------------------------------------- #
# tiles.py — tile coverage geometry
# --------------------------------------------------------------------------- #
def test_tiles_for_pixel_bbox_basic(manifest):
    z0 = next(lv for lv in manifest.levels if lv.z == 0)
    ts = manifest.fpack_tile_size
    # A box spanning pixels [100, 600) x [100, 300) touches tile cols 0..2, rows 0..1.
    tiles = tiles_for_pixel_bbox(z0, PixelBBox(100, 100, 600, 300), tile_size=ts)
    coords = {(t.tile_x, t.tile_y) for t in tiles}
    assert coords == {(x, y) for y in (0, 1) for x in (0, 1, 2)}


def test_tiles_for_pixel_bbox_boundary_no_bleed(manifest):
    z0 = next(lv for lv in manifest.levels if lv.z == 0)
    # A box ending exactly on the 256 boundary must not pull in the next column.
    tiles = tiles_for_pixel_bbox(z0, PixelBBox(0, 0, 256, 256), tile_size=256)
    assert {(t.tile_x, t.tile_y) for t in tiles} == {(0, 0)}
    tiles = tiles_for_pixel_bbox(z0, PixelBBox(0, 0, 257, 256), tile_size=256)
    assert {(t.tile_x, t.tile_y) for t in tiles} == {(0, 0), (1, 0)}


def test_tiles_for_pixel_bbox_clamps_and_empties(manifest):
    z0 = next(lv for lv in manifest.levels if lv.z == 0)
    ts = manifest.fpack_tile_size
    h, w = z0.shape
    # Fully outside -> empty.
    assert tiles_for_pixel_bbox(z0, PixelBBox(w + 10, 0, w + 20, 10), tile_size=ts) == []
    assert tiles_for_pixel_bbox(z0, PixelBBox(10, 10, 10, 10), tile_size=ts) == []  # degenerate
    # A box past the image edge clamps to the last tile.
    tiles = tiles_for_pixel_bbox(z0, PixelBBox(w - 5, h - 5, w + 100, h + 100), tile_size=ts)
    n_tx, n_ty = level_tile_grid(z0)
    assert {(t.tile_x, t.tile_y) for t in tiles} == {(n_tx - 1, n_ty - 1)}


def test_tiles_for_pixel_bbox_requires_tile_size(manifest):
    """tile_size is a required keyword — omitting it must raise, never silently
    assume 256 (the footgun that mis-tiles a non-256 dataset)."""
    z0 = next(lv for lv in manifest.levels if lv.z == 0)
    with pytest.raises(TypeError):
        tiles_for_pixel_bbox(z0, PixelBBox(0, 0, 256, 256))  # type: ignore[call-arg]
    with pytest.raises(TypeError):
        tile_pixel_bounds(z0, 0, 0)  # type: ignore[call-arg]
    with pytest.raises(TypeError):
        pixel_to_tile(z0, 0, 0)  # type: ignore[call-arg]


def test_tile_pixel_bounds_partial_edge(manifest):
    z2 = next(lv for lv in manifest.levels if lv.z == 2)  # 256x256 -> 1 tile
    b = tile_pixel_bounds(z2, 0, 0, tile_size=256)
    assert (b.x0, b.y0, b.x1, b.y1) == (0, 0, 256, 256)


def test_pixel_to_tile(manifest):
    z0 = next(lv for lv in manifest.levels if lv.z == 0)
    origin = pixel_to_tile(z0, 0, 0, tile_size=256)
    assert origin is not None and (origin.tile_x, origin.tile_y) == (0, 0)
    t = pixel_to_tile(z0, 300, 100, tile_size=256)
    assert t is not None and (t.tile_x, t.tile_y) == (1, 0)
    assert pixel_to_tile(z0, -1, 0, tile_size=256) is None
    h, w = z0.shape
    assert pixel_to_tile(z0, w, 0, tile_size=256) is None


# --------------------------------------------------------------------------- #
# fpack_index.py — byte addressing validated against astropy
# --------------------------------------------------------------------------- #
def _supertile_paths(outdir, manifest):
    out = []
    for lvl in manifest.levels:
        for st in lvl.supertiles:
            out.append(outdir / st.filename)
    return out


_ZQUANTIZ_TO_METHOD = {"SUBTRACTIVE_DITHER_1": 1, "SUBTRACTIVE_DITHER_2": 2}


def _assert_byte_ranges_match_astropy(outdir, manifest):
    """Every tile's byte range extracts exactly the bytes astropy reads for it,
    and tile_dims/n_pixels/params agree with astropy's own decode — checked on
    every supertile of every level."""
    checked_tiles = 0
    saw_partial_edge = False
    for path in _supertile_paths(outdir, manifest):
        raw = path.read_bytes()
        idx = SupertileIndex.open_local(str(path))

        # astropy's own view: COMPRESSED_DATA[row] is the exact compressed byte
        # array it would decode; the decoded image gives each tile's true pixels.
        with fits.open(path, disable_image_compression=True) as hdul:
            rec = hdul[1].data
            hdr = hdul[1].header
            comp = rec["COMPRESSED_DATA"]
            zscale = rec["ZSCALE"]
            zzero = rec["ZZERO"]
            has_zblank_col = "ZBLANK" in rec.columns.names
        with fits.open(path) as hdul:
            image = np.asarray(hdul[1].data)  # (rows, cols) = (znaxis2, znaxis1)

        # Decode params reported by the module must match the file's own header —
        # these (dither method/seed, blank sentinel, block size) drive a
        # self-decoding consumer and are otherwise unexercised.
        exp_method = _ZQUANTIZ_TO_METHOD.get(hdr.get("ZQUANTIZ"), -1)
        exp_zdither0 = int(hdr.get("ZDITHER0", 0) or 0)
        exp_block = int(hdr.get("ZBLOCKSIZE", 32) or 32)
        exp_zblank_hdr = hdr.get("ZBLANK")

        assert idx.n_tiles_x * idx.n_tiles_y == len(comp)
        for ly in range(idx.n_tiles_y):
            for lx in range(idx.n_tiles_x):
                row = idx.tile_row(lx, ly)
                br = idx.tile_byte_range(lx, ly)
                got = raw[br.start : br.stop]
                want = np.asarray(comp[row], dtype=np.uint8).tobytes()
                assert got == want, f"{path.name} tile ({lx},{ly}) byte range mismatch"
                # tile_dims must equal the tile's true (partial-edge-aware) shape.
                w, h = idx.tile_dims(lx, ly)
                # Independent spec-formula recomputation (NOT re-using the (w,h)
                # tile_dims returned): pins the value even where numpy would clamp
                # an over-large slice, so an under-reported interior tile fails.
                exp_w = min(idx.ztile1, idx.znaxis1 - lx * idx.ztile1)
                exp_h = min(idx.ztile2, idx.znaxis2 - ly * idx.ztile2)
                assert (w, h) == (exp_w, exp_h), f"{path.name} tile ({lx},{ly}) dims"
                sub = image[ly * idx.ztile2 : ly * idx.ztile2 + h, lx * idx.ztile1 : lx * idx.ztile1 + w]
                assert (w, h) == (sub.shape[1], sub.shape[0]), f"{path.name} tile ({lx},{ly}) sub"
                if w < idx.ztile1 or h < idx.ztile2:
                    saw_partial_edge = True
                params = idx.tile_params(lx, ly)
                assert params.tile_index == row
                assert params.n_pixels == w * h
                assert params.compression_type == "RICE_1"
                assert params.zscale == pytest.approx(float(zscale[row]))
                assert params.zzero == pytest.approx(float(zzero[row]))
                assert params.dither_method == exp_method
                assert params.zdither0 == exp_zdither0
                assert params.block_size == exp_block
                if not has_zblank_col:
                    if exp_zblank_hdr is None:
                        assert math.isnan(params.zblank)
                    else:
                        assert params.zblank == float(exp_zblank_hdr)
                checked_tiles += 1
    assert checked_tiles > 0
    return saw_partial_edge


def test_byte_ranges_match_astropy(pyramid, manifest):
    """Each tile's byte range must extract exactly the bytes astropy reads for it."""
    _assert_byte_ranges_match_astropy(pyramid["outdir"], manifest)


def test_tile_dims_full_tiles(pyramid, manifest):
    # z1 is 512x512 -> a single 2x2-tile supertile, all full tiles (no partial edge).
    z1 = next(lv for lv in manifest.levels if lv.z == 1)
    path = pyramid["outdir"] / z1.supertiles[0].filename
    idx = SupertileIndex.open_local(str(path))
    assert (idx.znaxis1, idx.znaxis2) == (512, 512)
    assert idx.tile_dims(0, 0) == (256, 256)
    assert idx.tile_dims(1, 1) == (256, 256)


def test_tile_dims_partial_edges(odd_pyramid, odd_manifest):
    """tile_dims shrinks on the high-index edge tiles of a level whose pixel
    dimensions are not a multiple of the fpack tile size (the odd, ZTILE=128
    pyramid). Full interior tiles stay square; every tile matches the spec
    formula computed independently of tile_dims' own return."""
    z0 = next(lv for lv in odd_manifest.levels if lv.z == 0)
    saw_partial = False
    saw_full = False
    for st in z0.supertiles:
        idx = SupertileIndex.open_local(str(odd_pyramid["outdir"] / st.filename))
        for ly in range(idx.n_tiles_y):
            for lx in range(idx.n_tiles_x):
                w, h = idx.tile_dims(lx, ly)
                assert w == min(idx.ztile1, idx.znaxis1 - lx * idx.ztile1)
                assert h == min(idx.ztile2, idx.znaxis2 - ly * idx.ztile2)
                if w < idx.ztile1 or h < idx.ztile2:
                    saw_partial = True
                if w == idx.ztile1 and h == idx.ztile2:
                    saw_full = True
    assert saw_partial, "odd pyramid must have at least one partial-edge tile"
    assert saw_full, "odd pyramid must also have full-size interior tiles"


def test_supertile_index_open_fetcher_matches_local(pyramid, manifest):
    """The fetcher-based open() matches open_local() and survives a tiny initial window."""
    path = pyramid["outdir"] / manifest.levels[0].supertiles[0].filename
    raw = path.read_bytes()

    calls = []

    def fetch(start, end_inclusive):
        calls.append((start, end_inclusive))
        return raw[start : end_inclusive + 1]

    # Force the header-growth + separate row-table read paths with a tiny window.
    idx = SupertileIndex.open(fetch, initial_bytes=64)
    local = SupertileIndex.open_local(str(path))
    for ly in range(idx.n_tiles_y):
        for lx in range(idx.n_tiles_x):
            assert idx.tile_byte_range(lx, ly) == local.tile_byte_range(lx, ly)
    assert len(calls) >= 2  # grew past 64 bytes at least once


def test_from_bytes_incomplete_raises(pyramid, manifest):
    path = pyramid["outdir"] / manifest.levels[0].supertiles[0].filename
    with pytest.raises(IncompleteHeaderError):
        SupertileIndex.from_bytes(path.read_bytes()[:100])


def test_tile_out_of_range_raises(pyramid, manifest):
    path = pyramid["outdir"] / manifest.levels[0].supertiles[0].filename
    idx = SupertileIndex.open_local(str(path))
    with pytest.raises(IndexError):
        idx.tile_byte_range(idx.n_tiles_x, 0)
    with pytest.raises(IndexError):
        idx.tile_params(0, idx.n_tiles_y)


def test_coalesce_ranges():
    assert coalesce_ranges([]) == []
    rs = [ByteRange(30, 5), ByteRange(0, 10), ByteRange(10, 5), ByteRange(20, 5)]
    # sorted: [0,10)+[10,15) merge; [20,25) and [30,35) stay separate at gap 0.
    assert coalesce_ranges(rs) == [ByteRange(0, 15), ByteRange(20, 5), ByteRange(30, 5)]
    # gap 5 bridges 15->20 and 25->30 into one span.
    assert coalesce_ranges(rs, max_gap=5) == [ByteRange(0, 35)]
    # overlap is unioned, not double-counted.
    assert coalesce_ranges([ByteRange(0, 20), ByteRange(5, 3)]) == [ByteRange(0, 20)]


def test_byte_range_helpers():
    br = ByteRange(100, 50)
    assert br.stop == 150
    assert br.http_range() == "bytes=100-149"


def test_gzip2_byte_ranges_match_astropy(tmp_path):
    """The GZIP_2 code path — an advertised ZCMPTYPE the build pipeline never
    emits — must address bytes correctly. Build a GZIP_2-compressed FITS with
    astropy and check every tile's byte range byte-for-byte against astropy's own
    COMPRESSED_DATA, plus the no-quantization (NaN ZSCALE/ZZERO) param branch.

    Integer data keeps the compressed bytes in COMPRESSED_DATA (a float image
    would land in the lossless GZIP_COMPRESSED_DATA column, which this
    addressing-only module intentionally does not serve)."""
    data = (np.arange(200 * 300, dtype=np.int32).reshape(200, 300) % 101).astype(np.int32)
    hdu = fits.CompImageHDU(data=data, compression_type="GZIP_2", tile_shape=(64, 64))
    path = tmp_path / "gzip2.fits.fz"
    hdu.writeto(path, overwrite=True)
    raw = path.read_bytes()

    idx = SupertileIndex.open_local(str(path))
    assert idx.compression_type == "GZIP_2"
    with fits.open(path, disable_image_compression=True) as hdul:
        comp = hdul[1].data["COMPRESSED_DATA"]
    assert idx.n_tiles_x * idx.n_tiles_y == len(comp)
    checked = 0
    for ly in range(idx.n_tiles_y):
        for lx in range(idx.n_tiles_x):
            row = idx.tile_row(lx, ly)
            br = idx.tile_byte_range(lx, ly)
            want = np.asarray(comp[row], dtype=np.uint8).tobytes()
            assert raw[br.start : br.stop] == want, f"GZIP_2 tile ({lx},{ly}) byte range"
            params = idx.tile_params(lx, ly)
            assert params.compression_type == "GZIP_2"
            # GZIP_2 is not quantized -> no per-tile ZSCALE/ZZERO columns.
            assert math.isnan(params.zscale)
            assert math.isnan(params.zzero)
            checked += 1
    assert checked == idx.n_tiles_x * idx.n_tiles_y


# --------------------------------------------------------------------------- #
# cutout.py — plan_cutout against astropy projection
# --------------------------------------------------------------------------- #
def _level_wcs(level):
    hdr = fits.Header()
    for k, v in level.wcs.items():
        hdr[k] = v
    return WCS(hdr)


def test_plan_cutout_selects_level_by_output_scale(manifest):
    # 60 arcsec FOV at 1000 px -> 0.06"/px -> z1.
    plan = plan_cutout(manifest, center=(150.0, 2.2), fov=60.0, output_size=1000)
    assert plan.level_index == 1
    assert plan.output_scale_arcsec == pytest.approx(0.06, rel=1e-3)
    # same FOV at 2000 px -> 0.03"/px -> z0.
    plan0 = plan_cutout(manifest, center=(150.0, 2.2), fov=60.0, output_size=2000)
    assert plan0.level_index == 0


def test_plan_cutout_target_scale_override(manifest):
    plan = plan_cutout(manifest, center=(150.0, 2.2), fov=30.0, target_scale_arcsec=0.12)
    assert plan.level_index == 2


def test_plan_cutout_defaults_to_native(manifest):
    plan = plan_cutout(manifest, center=(150.0, 2.2), fov=10.0)
    assert plan.level_index == 0


def test_plan_cutout_center_inside_covered_tiles(manifest):
    """The requested centre must project into the plan's pixel window and a covered tile."""
    center = (150.0, 2.2)
    plan = plan_cutout(manifest, center=center, fov=20.0, output_size=400)
    lvl = plan.level
    wcs = _level_wcs(lvl)
    cx, cy = wcs.world_to_pixel_values(center[0], center[1])
    col, row = int(math.floor(cx + 0.5)), int(math.floor(cy + 0.5))
    b = plan.pixel_bbox
    assert b.x0 <= col < b.x1 and b.y0 <= row < b.y1
    covered = {(t.tile.tile_x, t.tile.tile_y) for t in plan.tiles}
    assert (col // 256, row // 256) in covered


def test_plan_cutout_covers_full_sky_box(manifest):
    """Every corner of the requested box lands in a covered tile (rotated WCS).

    The FOV is chosen so the whole box lands comfortably inside the selected
    level; each corner is asserted in-image (not merely skipped when off-image)
    and a `checked` counter guards against the vacuity where all corners project
    outside the level and the coverage assertion silently never runs.
    """
    center = (150.0, 2.2)
    fov = (12.0, 8.0)
    plan = plan_cutout(manifest, center=center, fov=fov, output_size=(200, 133))
    lvl = plan.level
    wcs = _level_wcs(lvl)
    ts = manifest.fpack_tile_size
    h, w = lvl.shape
    covered = {(t.tile.tile_x, t.tile.tile_y) for t in plan.tiles}
    half_w = (fov[0] / 2) / 3600.0
    half_h = (fov[1] / 2) / 3600.0
    cosd = math.cos(math.radians(center[1]))
    checked = 0
    for sx in (-1, 1):
        for sy in (-1, 1):
            ra = center[0] + sx * half_w / cosd
            dec = center[1] + sy * half_h
            px, py = wcs.world_to_pixel_values(ra, dec)
            col, row = int(math.floor(px + 0.5)), int(math.floor(py + 0.5))
            assert 0 <= col < w and 0 <= row < h  # box must land inside the level
            assert (col // ts, row // ts) in covered
            checked += 1
    assert checked == 4


def test_plan_cutout_out_of_field_is_empty(manifest):
    # Far from the COSMOS field center -> no overlap.
    plan = plan_cutout(manifest, center=(10.0, -30.0), fov=10.0, output_size=200)
    assert plan.is_empty
    assert plan.tiles == []


def test_plan_cutout_reports_missing_gap_tiles():
    """A cutout covering a dropped-supertile gap routes those tiles into
    plan.missing (not plan.tiles) and is not reported empty — the integration
    path plan.missing exists for, previously covered only at the resolve_supertile
    unit level."""
    scale_deg = 0.03 / 3600.0
    wcs = {
        "WCSAXES": 2,
        "CTYPE1": "RA---TAN",
        "CTYPE2": "DEC--TAN",
        "CRPIX1": 256.5,
        "CRPIX2": 256.5,
        "CRVAL1": 150.0,
        "CRVAL2": 2.0,
        "CD1_1": -scale_deg,
        "CD1_2": 0.0,
        "CD2_1": 0.0,
        "CD2_2": scale_deg,
        "CUNIT1": "deg",
        "CUNIT2": "deg",
        "RADESYS": "ICRS",
    }
    # 512x512 level, 2x2 tiles @256; only the LEFT column of supertiles exists,
    # so every global tile with tile_x == 1 falls in a gap.
    level = LevelInfo(
        z=0,
        filename="left.fits.fz",
        compression="RICE_1",
        lossless=False,
        shape=[512, 512],
        fpack_tile_count=[2, 2],
        pixel_scale_arcsec=0.03,
        wcs=wcs,
        supertiles=[SupertileInfo(filename="left.fits.fz", tile_origin=[0, 0], tile_count=[1, 2])],
    )
    manifest = Manifest(
        source_file="s", native_shape=[512, 512], n_levels=0, fpack_tile_size=256, levels=[level]
    )
    # A box larger than the level covers all four tiles after clamping to [0,512).
    plan = plan_cutout(manifest, center=(150.0, 2.0), fov=18.0, output_size=600)
    assert plan.level_index == 0
    assert not plan.is_empty
    covered = {(t.tile.tile_x, t.tile.tile_y) for t in plan.tiles}
    missing = {(c.tile_x, c.tile_y) for c in plan.missing}
    assert missing == {(1, 0), (1, 1)}  # the whole right column is the gap
    assert covered == {(0, 0), (0, 1)}  # only the left column has data
    assert covered.isdisjoint(missing)


def test_plan_cutout_supertile_filenames(manifest):
    plan = plan_cutout(manifest, center=(150.0, 2.2), fov=60.0, output_size=2000)
    names = plan.supertile_filenames()
    assert names  # non-empty
    # Many covering tiles share each supertile file, so dedup must actually
    # collapse duplicates: strictly fewer distinct files than covering tiles.
    assert len(plan.tiles) > len(names)
    assert len(names) == len(set(names))  # each file listed once
    # the list is exactly the set of files the covering tiles reference
    assert set(names) == {ref.filename for ref in plan.tiles}
    # every listed name is a real supertile of the chosen level
    level_files = {st.filename for st in plan.level.supertiles}
    assert set(names) <= level_files


def test_plan_cutout_rejects_bad_args(manifest):
    with pytest.raises(ValueError):
        plan_cutout(manifest, center=(150.0, 2.2), fov=0.0, output_size=100)
    with pytest.raises(ValueError):
        plan_cutout(manifest, center=(150.0, 2.2), fov=10.0, target_scale_arcsec=-1.0)


def test_cutout_plan_is_dataclass(manifest):
    plan = plan_cutout(manifest, center=(150.0, 2.2), fov=20.0, output_size=400)
    assert isinstance(plan, CutoutPlan)
    for ref in plan.tiles:
        assert isinstance(ref.tile.tile_x, int)
        assert ref.filename.endswith(".fits.fz")
        # local coords index the supertile's own grid
        assert 0 <= ref.local_x < ref.supertile.tile_count[0]
        assert 0 <= ref.local_y < ref.supertile.tile_count[1]


def test_sky_box_perimeter_samples_full_edges():
    """The perimeter sampler must return more than the 4 corners, all on the box
    edge — the whole point is to bound a rotated/curved box, not just its corners."""
    from fitsgl.cutout import _sky_box_perimeter

    center = (150.0, 2.2)
    fov = (40.0, 20.0)  # arcsec
    ra, dec = _sky_box_perimeter(center, fov, samples=16)
    assert len(ra) > 4 and len(ra) == len(dec)
    half_w = (fov[0] / 2) / 3600.0
    half_h = (fov[1] / 2) / 3600.0
    # Recover each sample's on-sky RA offset with cos at that sample's own dec
    # (the sampler now widens RA per-dec, not by a single centre cosine).
    dra = (ra - center[0]) * np.cos(np.radians(dec))
    ddec = dec - center[1]
    # Every sample lies within the box, and on at least one edge (|offset| == half).
    assert np.all(np.abs(dra) <= half_w + 1e-12)
    assert np.all(np.abs(ddec) <= half_h + 1e-12)
    on_edge = np.isclose(np.abs(dra), half_w) | np.isclose(np.abs(ddec), half_h)
    assert np.all(on_edge)
    # more than four distinct points actually sit strictly between corners
    interior_of_edge = (np.abs(dra) < half_w - 1e-9) | (np.abs(ddec) < half_h - 1e-9)
    assert interior_of_edge.sum() >= 4


# --------------------------------------------------------------------------- #
# Non-square / non-256 / multi-supertile pyramid — exercises axis order, partial
# edge tiles, and manifest tile-size plumbing that the square fixture hides.
# --------------------------------------------------------------------------- #
def test_odd_manifest_shape(odd_manifest):
    assert odd_manifest.fpack_tile_size == 128
    z0 = next(lv for lv in odd_manifest.levels if lv.z == 0)
    assert list(z0.shape) == [360, 600]  # [H, W], non-square
    # fpack_tile_count is [n_ty, n_tx]; level_tile_grid returns (n_tx, n_ty).
    assert list(z0.fpack_tile_count) == [3, 5]
    assert level_tile_grid(z0) == (5, 3)  # n_tx != n_ty catches an axis swap
    assert len(z0.supertiles) > 1  # multi-supertile


def test_odd_partial_edge_pixel_bounds(odd_manifest):
    z0 = next(lv for lv in odd_manifest.levels if lv.z == 0)
    # last column tile spans x [512, 600) -> width 88; last row tile y [256, 360) -> 104.
    last = tile_pixel_bounds(z0, 4, 2, tile_size=128)
    assert (last.x0, last.x1, last.width) == (512, 600, 88)
    assert (last.y0, last.y1, last.height) == (256, 360, 104)
    full = tile_pixel_bounds(z0, 0, 0, tile_size=128)
    assert (full.width, full.height) == (128, 128)


def test_odd_byte_ranges_match_astropy(odd_pyramid, odd_manifest):
    """Byte addressing + tile_dims on partial edges and a non-square, ZTILE=128 grid."""
    saw_partial = _assert_byte_ranges_match_astropy(odd_pyramid["outdir"], odd_manifest)
    assert saw_partial  # the non-256, non-square pyramid must exercise partial-edge tiles


def test_odd_resolve_supertile_disjoint(odd_manifest):
    for lvl in odd_manifest.levels:
        n_tx, n_ty = level_tile_grid(lvl)
        for ty in range(n_ty):
            for tx in range(n_tx):
                m = resolve_supertile(lvl, tx, ty)
                assert m is not None
                assert 0 <= m.local_x < m.supertile.tile_count[0]
                assert 0 <= m.local_y < m.supertile.tile_count[1]


def test_plan_cutout_uses_manifest_tile_size(odd_manifest):
    """plan_cutout must tile by manifest.fpack_tile_size (128 here), not a hard 256.

    An interior request on a ZTILE=128 dataset would be silently under-covered (or
    reported empty) if the planner assumed 256, because the 256-based indices don't
    line up with the 128-based supertile grid."""
    center = (150.0, 2.2)
    plan = plan_cutout(odd_manifest, center=center, fov=8.0, output_size=200)
    assert not plan.is_empty
    lvl = plan.level
    wcs = _level_wcs(lvl)
    cx, cy = wcs.world_to_pixel_values(center[0], center[1])
    col, row = int(math.floor(cx + 0.5)), int(math.floor(cy + 0.5))
    ts = odd_manifest.fpack_tile_size
    covered = {(t.tile.tile_x, t.tile.tile_y) for t in plan.tiles}
    assert (col // ts, row // ts) in covered
    b = plan.pixel_bbox
    assert b.x0 <= col < b.x1 and b.y0 <= row < b.y1
    # every covered tile is a real tile of the chosen level (indices in 128 units)
    n_tx, n_ty = level_tile_grid(lvl)
    for tx, ty in covered:
        assert 0 <= tx < n_tx and 0 <= ty < n_ty


def test_plan_cutout_covers_full_sky_box_odd(odd_manifest):
    """Full-perimeter coverage on the rotated, non-256 odd pyramid.

    FOV chosen so the whole box lands inside the level; every perimeter sample is
    asserted in-image and covered (with a `checked` guard) so this can't silently
    go vacuous the way an oversized box would.
    """
    center = (150.0, 2.2)
    fov = (9.0, 6.0)
    plan = plan_cutout(odd_manifest, center=center, fov=fov, output_size=(300, 200))
    lvl = plan.level
    ts = odd_manifest.fpack_tile_size
    wcs = _level_wcs(lvl)
    h, w = lvl.shape
    covered = {(t.tile.tile_x, t.tile.tile_y) for t in plan.tiles}
    # Sample the whole perimeter densely (not just corners) so a regression that
    # drops edge sampling would leave an uncovered point.
    from fitsgl.cutout import _sky_box_perimeter

    ra, dec = _sky_box_perimeter(center, fov, samples=25)
    px, py = wcs.world_to_pixel_values(ra, dec)
    checked = 0
    for x, y in zip(np.atleast_1d(px), np.atleast_1d(py)):
        col, row = int(math.floor(x + 0.5)), int(math.floor(y + 0.5))
        assert 0 <= col < w and 0 <= row < h  # box must land inside the level
        assert (col // ts, row // ts) in covered
        checked += 1
    assert checked >= 25
