"""Tests for the fitsgl.toml parser/validator (config.py)."""

import textwrap

import pytest

from pyramid_gen.config import load_config


def write_toml(tmp_path, body: str):
    p = tmp_path / "fitsgl.toml"
    p.write_text(textwrap.dedent(body))
    return p


def touch(tmp_path, name: str):
    f = tmp_path / name
    f.write_text("")
    return f


def test_parses_a_valid_rgb_config(tmp_path):
    for n in ("a", "b", "c"):
        touch(tmp_path, f"{n}.fits")
    p = write_toml(
        tmp_path,
        """
        [dataset]
        name = "cosmos"
        title = "COSMOS"
        [[dataset.bands]]
        name = "a"
        input = "a.fits"
        [[dataset.bands]]
        name = "b"
        input = "b.fits"
        [[dataset.bands]]
        name = "c"
        input = "c.fits"
        [build]
        quantize_level = 16
        tile_size = 128
        [viewer]
        default = "rgb"
        r = "a"
        g = "b"
        b = "c"
        stretch = "asinh"
        north_up = true
        """,
    )
    cfg = load_config(p)
    assert cfg.name == "cosmos"
    assert cfg.title == "COSMOS"
    assert [b.name for b in cfg.bands] == ["a", "b", "c"]
    assert cfg.bands[0].input.name == "a.fits" and cfg.bands[0].input.is_absolute()
    assert cfg.build.quantize_level == 16 and cfg.build.tile_size == 128
    assert cfg.viewer.mode == "rgb"
    assert (cfg.viewer.r, cfg.viewer.g, cfg.viewer.b) == ("a", "b", "c")
    assert cfg.viewer.stretch == "asinh" and cfg.viewer.north_up is True
    assert cfg.catalog is None


def test_minimal_single_band_uses_defaults(tmp_path):
    touch(tmp_path, "img.fits")
    p = write_toml(
        tmp_path,
        """
        [dataset]
        name = "x"
        [[dataset.bands]]
        name = "img"
        input = "img.fits"
        """,
    )
    cfg = load_config(p)
    assert cfg.viewer.mode == "single" and cfg.viewer.band is None
    assert cfg.build.quantize_level == 8 and cfg.build.tile_size == 256
    assert cfg.catalog is None and cfg.title is None


def test_catalog_path_resolved_and_checked(tmp_path):
    touch(tmp_path, "a.fits")
    touch(tmp_path, "sources.csv")
    p = write_toml(
        tmp_path,
        """
        [dataset]
        name = "x"
        catalog = "sources.csv"
        [[dataset.bands]]
        name = "a"
        input = "a.fits"
        """,
    )
    cfg = load_config(p)
    assert cfg.catalog is not None and cfg.catalog.name == "sources.csv"


def test_missing_config_file(tmp_path):
    with pytest.raises(FileNotFoundError):
        load_config(tmp_path / "nope.toml")


def test_missing_band_input(tmp_path):
    p = write_toml(
        tmp_path,
        """
        [dataset]
        name = "x"
        [[dataset.bands]]
        name = "a"
        input = "missing.fits"
        """,
    )
    with pytest.raises(FileNotFoundError):
        load_config(p)


def test_duplicate_band_name(tmp_path):
    touch(tmp_path, "a.fits")
    p = write_toml(
        tmp_path,
        """
        [dataset]
        name = "x"
        [[dataset.bands]]
        name = "a"
        input = "a.fits"
        [[dataset.bands]]
        name = "a"
        input = "a.fits"
        """,
    )
    with pytest.raises(ValueError, match="duplicate band name"):
        load_config(p)


def test_reserved_band_name(tmp_path):
    touch(tmp_path, "c.fits")
    p = write_toml(
        tmp_path,
        """
        [dataset]
        name = "x"
        [[dataset.bands]]
        name = "catalog"
        input = "c.fits"
        """,
    )
    with pytest.raises(ValueError, match="reserved"):
        load_config(p)


def test_rgb_requires_all_channels(tmp_path):
    touch(tmp_path, "a.fits")
    p = write_toml(
        tmp_path,
        """
        [dataset]
        name = "x"
        [[dataset.bands]]
        name = "a"
        input = "a.fits"
        [viewer]
        default = "rgb"
        r = "a"
        """,
    )
    with pytest.raises(ValueError, match="g is required"):
        load_config(p)


def test_viewer_references_unknown_band(tmp_path):
    touch(tmp_path, "a.fits")
    p = write_toml(
        tmp_path,
        """
        [dataset]
        name = "x"
        [[dataset.bands]]
        name = "a"
        input = "a.fits"
        [viewer]
        default = "single"
        band = "zzz"
        """,
    )
    with pytest.raises(ValueError, match="unknown band"):
        load_config(p)


def test_bad_stretch_mode(tmp_path):
    touch(tmp_path, "a.fits")
    p = write_toml(
        tmp_path,
        """
        [dataset]
        name = "x"
        [[dataset.bands]]
        name = "a"
        input = "a.fits"
        [viewer]
        stretch = "sqrt"
        """,
    )
    with pytest.raises(ValueError, match="stretch must be one of"):
        load_config(p)


def test_colormap_rejected_in_rgb_mode(tmp_path):
    for n in ("a", "b", "c"):
        touch(tmp_path, f"{n}.fits")
    p = write_toml(
        tmp_path,
        """
        [dataset]
        name = "x"
        [[dataset.bands]]
        name = "a"
        input = "a.fits"
        [[dataset.bands]]
        name = "b"
        input = "b.fits"
        [[dataset.bands]]
        name = "c"
        input = "c.fits"
        [viewer]
        default = "rgb"
        r = "a"
        g = "b"
        b = "c"
        colormap = "viridis"
        """,
    )
    with pytest.raises(ValueError, match="colormap applies to single-band"):
        load_config(p)
