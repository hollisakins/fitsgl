"""Tests for pre-computed band display stats (stats.py)."""

import numpy as np

from pyramid_gen.manifest import LevelInfo, Manifest, SupertileInfo
from pyramid_gen.stats import HISTOGRAM_BINS, _choose_level, histogram_dict


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
