"""Tests for pre-computed band display stats (stats.py)."""

import numpy as np

from pyramid_gen.manifest import LevelInfo, Manifest
from pyramid_gen.stats import (
    HISTOGRAM_BINS,
    _choose_level,
    histogram_dict,
    trilogy_stats_dict,
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


def test_trilogy_stats_dict_basic():
    rng = np.random.default_rng(1)
    data = rng.normal(100.0, 5.0, size=(400, 400)).astype("float32")
    data[:10] = np.nan  # NaN padding is ignored
    data[100, 100] = 5000.0  # a bright source in the saturation tail
    s = trilogy_stats_dict(data)
    assert s is not None
    # Robust sky mean/noise: median ~ 100, MAD-scaled sigma ~ 5.
    assert abs(s["mean"] - 100.0) < 1.0
    assert abs(s["sigma"] - 5.0) < 1.0
    # Bright-tail percentiles are monotonic and the max reaches the hot pixel.
    t = s["tail"]
    assert t["p99"] < t["p99_9"] <= t["p99_99"] <= t["p99_999"] <= t["max"]
    assert t["max"] == 5000.0
    assert s["min"] < s["mean"]


def test_trilogy_stats_dict_all_nan_is_none():
    assert trilogy_stats_dict(np.full((16, 16), np.nan, dtype="float32")) is None


def test_trilogy_stats_dict_subsamples_past_cap():
    # A cap below the finite count exercises the stride path without changing shape.
    data = np.linspace(0.0, 1000.0, 10_000, dtype="float32").reshape(100, 100)
    s = trilogy_stats_dict(data, sample_cap=1000)
    assert s is not None
    assert s["tail"]["max"] <= 1000.0
    assert s["sigma"] > 0


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
