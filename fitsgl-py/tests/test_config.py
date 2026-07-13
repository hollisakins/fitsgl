"""Tests for the fitsgl.toml parser/validator (config.py)."""

import textwrap

import pytest

from fitsgl.config import load_config


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
    assert cfg.bands[0].inputs == [tmp_path / "a.fits"]
    assert cfg.bands[0].inputs[0].is_absolute()
    assert cfg.build.quantize_level == 16 and cfg.build.tile_size == 128
    assert cfg.viewer.mode == "rgb"
    assert (cfg.viewer.r, cfg.viewer.g, cfg.viewer.b) == ("a", "b", "c")
    assert cfg.viewer.stretch == "asinh" and cfg.viewer.north_up is True
    assert cfg.catalog is None


def test_band_accepts_a_list_of_tile_inputs(tmp_path):
    for n in ("t1", "t2", "t3"):
        touch(tmp_path, f"{n}.fits")
    p = write_toml(
        tmp_path,
        """
        [dataset]
        name = "x"
        [[dataset.bands]]
        name = "f277w"
        input = ["t1.fits", "t2.fits", "t3.fits"]
        """,
    )
    cfg = load_config(p)
    assert [pth.name for pth in cfg.bands[0].inputs] == ["t1.fits", "t2.fits", "t3.fits"]
    assert all(pth.is_absolute() for pth in cfg.bands[0].inputs)


def test_band_input_glob_expands_sorted(tmp_path):
    for n in ("B2", "B1", "B3"):
        touch(tmp_path, f"tile_{n}.fits")
    touch(tmp_path, "ignore.txt")
    p = write_toml(
        tmp_path,
        """
        [dataset]
        name = "x"
        [[dataset.bands]]
        name = "f277w"
        input = "tile_*.fits"
        """,
    )
    cfg = load_config(p)
    assert [pth.name for pth in cfg.bands[0].inputs] == [
        "tile_B1.fits",
        "tile_B2.fits",
        "tile_B3.fits",
    ]


def test_band_input_glob_no_match_raises(tmp_path):
    p = write_toml(
        tmp_path,
        """
        [dataset]
        name = "x"
        [[dataset.bands]]
        name = "f277w"
        input = "missing_*.fits"
        """,
    )
    with pytest.raises(FileNotFoundError, match="glob"):
        load_config(p)


def test_build_supertile_blocks_knob(tmp_path):
    touch(tmp_path, "a.fits")
    base = '[dataset]\nname = "x"\n[[dataset.bands]]\nname = "a"\ninput = "a.fits"\n'
    # Default: None -> the builder picks its own default.
    assert load_config(write_toml(tmp_path, base)).build.supertile_blocks is None
    # Explicit override parses.
    cfg = load_config(write_toml(tmp_path, base + "[build]\nsupertile_blocks = 32\n"))
    assert cfg.build.supertile_blocks == 32
    # Must be >= 1.
    with pytest.raises(ValueError, match="supertile_blocks"):
        load_config(write_toml(tmp_path, base + "[build]\nsupertile_blocks = 0\n"))


def test_band_input_list_missing_file_raises(tmp_path):
    touch(tmp_path, "t1.fits")
    p = write_toml(
        tmp_path,
        """
        [dataset]
        name = "x"
        [[dataset.bands]]
        name = "f277w"
        input = ["t1.fits", "nope.fits"]
        """,
    )
    with pytest.raises(FileNotFoundError, match="not found"):
        load_config(p)


def test_parses_full_deploy_block(tmp_path):
    touch(tmp_path, "a.fits")
    p = write_toml(
        tmp_path,
        """
        [dataset]
        name = "cosmos"
        [[dataset.bands]]
        name = "a"
        input = "a.fits"
        [deploy]
        target = "r2"
        bucket = "cosmos-web"
        endpoint = "https://acct.r2.cloudflarestorage.com"
        public_url = "https://data.example.org/cosmos-web"
        zone_id = "zone123"
        prefix = "cosmos"
        viewer_origin = "https://campfire.example"
        tile_max_age = 86400
        concurrency = 16
        """,
    )
    d = load_config(p).deploy
    assert d is not None
    assert (d.bucket, d.endpoint) == ("cosmos-web", "https://acct.r2.cloudflarestorage.com")
    assert d.public_url == "https://data.example.org/cosmos-web"
    assert (d.zone_id, d.prefix, d.viewer_origin) == ("zone123", "cosmos", "https://campfire.example")
    assert d.tile_max_age == 86400 and d.concurrency == 16 and d.target == "r2"


def test_deploy_absent_is_none(tmp_path):
    touch(tmp_path, "a.fits")
    p = write_toml(tmp_path, '[dataset]\nname = "x"\n[[dataset.bands]]\nname = "a"\ninput = "a.fits"\n')
    assert load_config(p).deploy is None


def test_deploy_minimal_uses_defaults(tmp_path):
    touch(tmp_path, "a.fits")
    base = '[dataset]\nname = "x"\n[[dataset.bands]]\nname = "a"\ninput = "a.fits"\n'
    p = write_toml(tmp_path, base + '[deploy]\nbucket = "b"\nendpoint = "https://e"\npublic_url = "https://u"\n')
    d = load_config(p).deploy
    assert d is not None
    assert d.zone_id is None and d.prefix == "" and d.viewer_origin == "*"
    assert d.tile_max_age == 604800 and d.swr_grace == 2592000  # defaults; swr_grace not a TOML knob
    assert d.concurrency == 8  # default parallel upload streams


def test_deploy_validation_errors(tmp_path):
    touch(tmp_path, "a.fits")
    base = '[dataset]\nname = "x"\n[[dataset.bands]]\nname = "a"\ninput = "a.fits"\n'

    def load(deploy_body):
        return load_config(write_toml(tmp_path, base + "[deploy]\n" + deploy_body))

    with pytest.raises(ValueError, match="bucket"):  # required field missing
        load('endpoint = "https://e"\npublic_url = "https://u"\n')
    with pytest.raises(ValueError, match="target"):  # only "r2" supported
        load('target = "s3"\nbucket = "b"\nendpoint = "https://e"\npublic_url = "https://u"\n')
    with pytest.raises(ValueError, match="tile_max_age"):  # must be positive
        load('bucket = "b"\nendpoint = "https://e"\npublic_url = "https://u"\ntile_max_age = 0\n')
    with pytest.raises(ValueError, match="concurrency"):  # must be positive
        load('bucket = "b"\nendpoint = "https://e"\npublic_url = "https://u"\nconcurrency = 0\n')


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


def test_slugs_unsafe_band_name_and_keeps_label(tmp_path):
    touch(tmp_path, "img.fits")
    p = write_toml(
        tmp_path,
        """
        [dataset]
        name = "x"
        [[dataset.bands]]
        name = "NIRCam F277W"
        input = "img.fits"
        """,
    )
    with pytest.warns(UserWarning, match="not URL-safe"):
        cfg = load_config(p)
    assert cfg.bands[0].name == "NIRCam_F277W"  # slug used for dir/URL
    assert cfg.bands[0].label == "NIRCam F277W"  # original kept as display label


def test_explicit_label_silences_slug_warning(tmp_path):
    import warnings as w

    touch(tmp_path, "img.fits")
    p = write_toml(
        tmp_path,
        """
        [dataset]
        name = "x"
        [[dataset.bands]]
        name = "F277W"
        label = "NIRCam F277W"
        input = "img.fits"
        """,
    )
    with w.catch_warnings(record=True) as rec:
        w.simplefilter("always")
        cfg = load_config(p)
    assert cfg.bands[0].name == "F277W" and cfg.bands[0].label == "NIRCam F277W"
    assert not any("not URL-safe" in str(r.message) for r in rec)  # explicit label silences it


def test_colliding_slugs_rejected(tmp_path):
    touch(tmp_path, "a.fits")
    touch(tmp_path, "b.fits")
    p = write_toml(
        tmp_path,
        """
        [dataset]
        name = "x"
        [[dataset.bands]]
        name = "a b"
        input = "a.fits"
        [[dataset.bands]]
        name = "a/b"
        input = "b.fits"
        """,
    )
    with pytest.warns(UserWarning):
        with pytest.raises(ValueError, match="collides"):
            load_config(p)


def test_viewer_refs_resolve_to_slug(tmp_path):
    for n in ("a", "b", "c"):
        touch(tmp_path, f"{n}.fits")
    p = write_toml(
        tmp_path,
        """
        [dataset]
        name = "x"
        [[dataset.bands]]
        name = "NIRCam F150W"
        input = "a.fits"
        [[dataset.bands]]
        name = "NIRCam F277W"
        input = "b.fits"
        [[dataset.bands]]
        name = "NIRCam F444W"
        input = "c.fits"
        [viewer]
        default = "rgb"
        r = "NIRCam F444W"
        g = "NIRCam F277W"
        b = "NIRCam F150W"
        """,
    )
    with pytest.warns(UserWarning):
        cfg = load_config(p)
    # [viewer] refs (typed as the original names) resolve to the slugs used downstream.
    assert (cfg.viewer.r, cfg.viewer.g, cfg.viewer.b) == ("NIRCam_F444W", "NIRCam_F277W", "NIRCam_F150W")


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


def test_trilogy_stretch_mode_is_accepted(tmp_path):
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
        stretch = "trilogy"
        """,
    )
    assert load_config(p).viewer.stretch == "trilogy"


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


def test_viewer_weights_and_trilogy_knobs(tmp_path):
    for n in ("a", "b", "c"):
        touch(tmp_path, f"{n}.fits")
    p = write_toml(
        tmp_path,
        """
        [dataset]
        name = "cosmos"
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
        r = "c"
        g = "b"
        b = "a"
        stretch = "trilogy"
        [viewer.weights]
        a = [0.0, 0.0, 1.0]
        b = [0.0, 1.0, 0.0]
        c = [1.0, 0.5, 0.0]
        [viewer.trilogy]
        noiselum = 0.12
        satpercent = 0.01
        """,
    )
    cfg = load_config(p)
    assert cfg.viewer.weights == {
        "a": (0.0, 0.0, 1.0),
        "b": (0.0, 1.0, 0.0),
        "c": (1.0, 0.5, 0.0),
    }
    assert list(cfg.viewer.weights) == ["a", "b", "c"]  # declaration order kept
    assert cfg.viewer.trilogy == {"noiselum": 0.12, "satpercent": 0.01}


def _viewer_toml(tmp_path, viewer_body):
    for n in ("a", "b", "c"):
        touch(tmp_path, f"{n}.fits")
    return write_toml(
        tmp_path,
        f"""
        [dataset]
        name = "cosmos"
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
        {viewer_body}
        """,
    )


def test_viewer_weights_reject_unknown_band_and_single_mode(tmp_path):
    import pytest

    p = _viewer_toml(
        tmp_path,
        'default = "rgb"\nr = "a"\ng = "b"\nb = "c"\n[viewer.weights]\nzz = [1.0, 0.0, 0.0]',
    )
    with pytest.raises(Exception, match="unknown band 'zz'"):
        load_config(p)
    p = _viewer_toml(tmp_path, 'default = "single"\n[viewer.weights]\na = [1.0, 0.0, 0.0]')
    with pytest.raises(Exception, match=r'requires default = "rgb"'):
        load_config(p)


def test_viewer_trilogy_rejects_bad_knobs(tmp_path):
    import pytest

    p = _viewer_toml(tmp_path, 'default = "single"\n[viewer.trilogy]\nnoiselum = 1.5')
    with pytest.raises(Exception, match=r"noiselum must be in \(0, 1\)"):
        load_config(p)
    p = _viewer_toml(tmp_path, 'default = "single"\n[viewer.trilogy]\nnope = 1.0')
    with pytest.raises(Exception, match="unknown knob 'nope'"):
        load_config(p)
