"""Tests for pre-computed band display stats (stats.py)."""

import numpy as np
from astropy.io import fits

from fitsgl.manifest import LevelInfo, Manifest, SupertileInfo
from fitsgl.stats import (
    HISTOGRAM_BINS,
    _choose_level,
    compute_band_trilogy_stats,
    histogram_dict,
    trilogy_stats_dict,
    zscale_limits,
)


def _lvl(z: int, rows: int, cols: int) -> LevelInfo:
    return LevelInfo(
        z=z,
        filename=f"x_z{z}.fits.fz",
        compression="RICE_1",
        lossless=False,
        shape=[rows, cols],
        fpack_tile_count=[1, 1],
        pixel_scale_arcsec=0.03 * 2**z,
        wcs={},
        supertiles=[SupertileInfo(filename=f"x_z{z}.fits.fz", tile_origin=[0, 0], tile_count=[1, 1])],
    )


def test_histogram_dict_basic():
    rng = np.random.default_rng(0)
    data = rng.normal(10.0, 2.0, size=(200, 200)).astype("float32")
    data[:10] = np.nan  # NaN padding is ignored
    h = histogram_dict(data)
    assert h is not None
    assert len(h["counts"]) == HISTOGRAM_BINS
    assert all(isinstance(c, int) for c in h["counts"])
    assert h["lo"] < h["hi"]
    assert 0 < sum(h["counts"]) <= int(np.isfinite(data).sum())


def test_histogram_dict_all_nan_is_none():
    assert histogram_dict(np.full((16, 16), np.nan, dtype="float32")) is None


def test_histogram_dict_degenerate_is_none():
    # A single repeated value has no spread -> no useful histogram.
    assert histogram_dict(np.full((16, 16), 5.0, dtype="float32")) is None


# ---------------------------------------------------------------- trilogy stats


def test_trilogy_stats_dict_basic():
    rng = np.random.default_rng(1)
    data = rng.normal(100.0, 5.0, size=(400, 400)).astype("float32")
    data[:10] = np.nan  # NaN padding is ignored
    data[100, 100] = 5000.0  # a bright source lifts the tail percentiles
    s = trilogy_stats_dict(data.reshape(-1))
    assert s is not None
    # Exactly the trimmed wire shape — no dead `min` / `tail.max`.
    assert set(s) == {"mean", "sigma", "tail"}
    assert set(s["tail"]) == {"p99", "p99_9", "p99_99", "p99_999"}
    # Robust sky mean/noise: median ~ 100, MAD-scaled sigma ~ 5.
    assert abs(s["mean"] - 100.0) < 1.0
    assert abs(s["sigma"] - 5.0) < 1.0
    t = s["tail"]
    assert t["p99"] < t["p99_9"] <= t["p99_99"] <= t["p99_999"]


def test_trilogy_stats_dict_all_nan_is_none():
    assert trilogy_stats_dict(np.full(1024, np.nan, dtype="float32")) is None


def test_trilogy_stats_dict_constant_is_none():
    # A constant band has MAD == 0 -> sigma == 0 -> no usable stretch (mirrors
    # histogram_dict's degenerate->None policy, so it never ships sigma == 0).
    assert trilogy_stats_dict(np.full(1024, 5.0, dtype="float32")) is None


def test_trilogy_stats_dict_single_outlier_on_flat_field_is_none():
    # One bright pixel on an otherwise constant field still has MAD == 0.
    d = np.full(1024, 5.0, dtype="float32")
    d[0] = 9999.0
    assert trilogy_stats_dict(d) is None


def test_trilogy_stats_dict_ignores_nans():
    rng = np.random.default_rng(2)
    finite = rng.normal(20.0, 3.0, size=100_000).astype("float32")
    withnan = np.concatenate([finite, np.full(40_000, np.nan, dtype="float32")])
    a = trilogy_stats_dict(finite)
    b = trilogy_stats_dict(withnan)
    assert a is not None and b is not None
    assert a == b  # the NaNs are dropped, so the stats are identical


def _write_level_file(path, data):
    """A plain (uncompressed) FITS image so the data round-trips exactly — no RICE
    float quantization to perturb the degenerate (constant-band) cases."""
    fits.PrimaryHDU(data=np.asarray(data, dtype="float32")).writeto(path, overwrite=True)


def _level(z, filenames, rows, cols):
    return LevelInfo(
        z=z,
        filename=filenames[0],
        compression="NONE",
        lossless=True,
        shape=[rows, cols],
        fpack_tile_count=[1, 1],
        pixel_scale_arcsec=0.03 * 2**z,
        wcs={},
        supertiles=[
            SupertileInfo(filename=f, tile_origin=[0, 0], tile_count=[1, 1]) for f in filenames
        ],
    )


def test_trilogy_stats_native_level_basic(tmp_path):
    rng = np.random.default_rng(3)
    data = rng.normal(100.0, 5.0, size=(300, 300)).astype("float32")
    _write_level_file(tmp_path / "b_z0.fits", data)
    m = Manifest(
        source_file="x.fits", native_shape=[300, 300], n_levels=1,
        levels=[_level(0, ["b_z0.fits"], 300, 300)],
    )
    s = compute_band_trilogy_stats(tmp_path, m)
    assert s is not None
    assert abs(s["mean"] - 100.0) < 1.0 and abs(s["sigma"] - 5.0) < 1.0


def test_trilogy_stats_reads_native_not_coarse(tmp_path):
    # z=0 has the real per-pixel noise (sigma ~ 5); a coarse z=1 is block-smoothed
    # (sigma ~ 0.5). The function must read z=0, so the reported sigma is ~ 5.
    rng = np.random.default_rng(4)
    _write_level_file(tmp_path / "b_z0.fits", rng.normal(100.0, 5.0, size=(300, 300)))
    _write_level_file(tmp_path / "b_z1.fits", rng.normal(100.0, 0.5, size=(150, 150)))
    m = Manifest(
        source_file="x.fits", native_shape=[300, 300], n_levels=2,
        levels=[_level(0, ["b_z0.fits"], 300, 300), _level(1, ["b_z1.fits"], 150, 150)],
    )
    s = compute_band_trilogy_stats(tmp_path, m)
    assert s is not None and abs(s["sigma"] - 5.0) < 1.0  # native noise, not the coarse one


def test_trilogy_stats_subsampling_stays_bounded(tmp_path):
    # ~90k native finite pixels; a tiny sample_cap strides the sample down but the
    # robust stats stay representative (and the call doesn't blow up).
    rng = np.random.default_rng(5)
    _write_level_file(tmp_path / "b_z0.fits", rng.normal(50.0, 3.0, size=(300, 300)))
    m = Manifest(
        source_file="x.fits", native_shape=[300, 300], n_levels=1,
        levels=[_level(0, ["b_z0.fits"], 300, 300)],
    )
    small = compute_band_trilogy_stats(tmp_path, m, sample_cap=5_000)
    full = compute_band_trilogy_stats(tmp_path, m, sample_cap=2_000_000)
    assert small is not None and full is not None
    assert abs(small["mean"] - full["mean"]) < 0.3
    assert abs(small["sigma"] - full["sigma"]) < 0.3


def test_trilogy_stats_multi_supertile_accumulation(tmp_path):
    # A native level chunked into TWO supertiles, one centered low, one high. If only
    # the first were read the median would be ~80; reading both puts it ~100.
    rng = np.random.default_rng(6)
    _write_level_file(tmp_path / "b_z0_a.fits", rng.normal(80.0, 2.0, size=(200, 200)))
    _write_level_file(tmp_path / "b_z0_b.fits", rng.normal(120.0, 2.0, size=(200, 200)))
    m = Manifest(
        source_file="x.fits", native_shape=[200, 400], n_levels=1,
        levels=[_level(0, ["b_z0_a.fits", "b_z0_b.fits"], 200, 400)],
    )
    s = compute_band_trilogy_stats(tmp_path, m)
    assert s is not None and abs(s["mean"] - 100.0) < 2.0  # both supertiles accumulated


def test_trilogy_stats_all_nan_native_is_none(tmp_path):
    _write_level_file(tmp_path / "b_z0.fits", np.full((64, 64), np.nan, dtype="float32"))
    m = Manifest(
        source_file="x.fits", native_shape=[64, 64], n_levels=1,
        levels=[_level(0, ["b_z0.fits"], 64, 64)],
    )
    assert compute_band_trilogy_stats(tmp_path, m) is None


def test_trilogy_stats_constant_native_is_none(tmp_path):
    _write_level_file(tmp_path / "b_z0.fits", np.full((64, 64), 7.0, dtype="float32"))
    m = Manifest(
        source_file="x.fits", native_shape=[64, 64], n_levels=1,
        levels=[_level(0, ["b_z0.fits"], 64, 64)],
    )
    assert compute_band_trilogy_stats(tmp_path, m) is None


def test_choose_level_picks_finest_within_cap():
    # pixels: z0=64M, z1=16M, z2=4M, z3=1M.
    m = Manifest(
        source_file="x.fits",
        native_shape=[8000, 8000],
        n_levels=3,
        levels=[_lvl(0, 8000, 8000), _lvl(1, 4000, 4000), _lvl(2, 2000, 2000), _lvl(3, 1000, 1000)],
    )
    assert _choose_level(m, 2_000_000).z == 3  # only z3 (1M) is within 2M
    assert _choose_level(m, 5_000_000).z == 2  # z2 (4M) is the finest within 5M
    assert _choose_level(m, 1).z == 3  # nothing fits -> coarsest


def test_zscale_limits_basic():
    rng = np.random.default_rng(0)
    # A gaussian sky + a few bright sources: zscale should bracket the sky, not the peaks.
    data = rng.normal(100.0, 5.0, size=20000).astype(np.float32)
    data[:50] = 5000.0  # bright tail
    z = zscale_limits(data)
    assert z is not None
    z1, z2 = z
    assert z2 > z1
    # The cuts sit around the sky (~100), nowhere near the 5000 outliers.
    assert 50 < z1 < 150 and 60 < z2 < 220


def test_zscale_limits_ignores_nans_and_handles_degenerate():
    d = np.array([1.0, np.nan, np.inf, 2.0, np.nan], dtype=np.float32)
    z = zscale_limits(d)
    assert z is None or (z[1] > z[0])  # finite-only; may be degenerate on 2 points
    assert zscale_limits(np.full(100, 7.0, dtype=np.float32)) is None  # constant → None
    assert zscale_limits(np.array([], dtype=np.float32)) is None
