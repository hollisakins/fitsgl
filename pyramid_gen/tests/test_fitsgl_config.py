"""Tests for the fitsgl.json emitter (fitsgl_config.py) — the producer contract."""

import json

import pytest

from pyramid_gen.fitsgl_config import (
    FITSGL_SCHEMA_VERSION,
    assign_grid_groups,
    build_fitsgl_config,
    default_view_dict,
)
from pyramid_gen.manifest import LevelInfo, Manifest, write_manifest


def _wcs(crval0: float = 150.0) -> dict:
    return {
        "CTYPE1": "RA---TAN",
        "CTYPE2": "DEC--TAN",
        "CRPIX1": 64.5,
        "CRPIX2": 64.5,
        "CRVAL1": crval0,
        "CRVAL2": 2.2,
        "CD1_1": -8.333e-6,
        "CD1_2": 0.0,
        "CD2_1": 0.0,
        "CD2_2": 8.333e-6,
    }


def _manifest(name: str, crval0: float = 150.0, scale: float = 0.03) -> Manifest:
    lvl = LevelInfo(
        z=0,
        filename=f"{name}_z0.fits.fz",
        compression="RICE_1",
        lossless=False,
        shape=[128, 128],
        fpack_tile_count=[1, 1],
        pixel_scale_arcsec=scale,
        wcs=_wcs(crval0),
    )
    return Manifest(source_file=f"{name}.fits", native_shape=[128, 128], n_levels=0, levels=[lvl])


def _band(tmp_path, name: str, crval0: float = 150.0, scale: float = 0.03, label: str | None = None):
    d = tmp_path / name
    d.mkdir()
    write_manifest(d / "manifest.json", _manifest(name, crval0, scale))
    return (name, label if label is not None else name, d / "manifest.json")


def test_emits_valid_wire_format(tmp_path):
    bands = [_band(tmp_path, "a"), _band(tmp_path, "b"), _band(tmp_path, "c")]  # all co-gridded
    dv = default_view_dict(mode="rgb", r="a", g="b", b="c", stretch="asinh", north_up=True)
    out = tmp_path / "fitsgl.json"
    cfg = build_fitsgl_config(bands, out, name="set", title="My Set", default_view=dv, catalog_url="catalog.csv")

    assert cfg["schemaVersion"] == FITSGL_SCHEMA_VERSION
    assert cfg["dataset"]["name"] == "set" and cfg["dataset"]["title"] == "My Set"
    assert cfg["dataset"]["catalog"] == {"url": "catalog.csv"}
    assert [b["name"] for b in cfg["dataset"]["bands"]] == ["a", "b", "c"]
    assert [b["label"] for b in cfg["dataset"]["bands"]] == ["a", "b", "c"]
    assert cfg["dataset"]["bands"][0]["tiles"] == ["a/manifest.json"]
    assert cfg["dataset"]["bands"][0]["grid"] == {"group": 0, "pixelScaleArcsec": 0.03}
    assert {b["grid"]["group"] for b in cfg["dataset"]["bands"]} == {0}  # co-gridded
    assert cfg["defaultView"] == {
        "mode": "rgb",
        "r": "a",
        "g": "b",
        "b": "c",
        "stretch": {"mode": "asinh"},
        "northUp": True,
    }
    # The file round-trips and uses camelCase wire keys.
    assert json.loads(out.read_text()) == cfg


def test_emits_human_label_distinct_from_slug_name(tmp_path):
    bands = [_band(tmp_path, "nircam_f277w", label="NIRCam F277W")]
    out = tmp_path / "fitsgl.json"
    dv = default_view_dict(mode="single", band="nircam_f277w")
    cfg = build_fitsgl_config(bands, out, name="set", default_view=dv)
    b = cfg["dataset"]["bands"][0]
    assert b["name"] == "nircam_f277w" and b["label"] == "NIRCam F277W"


def test_assigns_grid_groups_by_grid_hash(tmp_path):
    # a, b co-gridded (same WCS); c is 50 deg away -> its own group.
    manifests = [_manifest("a", 150.0), _manifest("b", 150.0), _manifest("c", 200.0)]
    assert assign_grid_groups(manifests, ["a", "b", "c"]) == [0, 0, 1]


def test_default_view_single_includes_colormap():
    dv = default_view_dict(mode="single", band="a", colormap="viridis", stretch="log")
    assert dv == {"mode": "single", "band": "a", "colormap": "viridis", "stretch": {"mode": "log"}}


def test_default_view_omits_optional_fields():
    assert default_view_dict(mode="single") == {"mode": "single"}


def test_warns_when_rgb_default_spans_grids(tmp_path):
    bands = [_band(tmp_path, "a", 150.0), _band(tmp_path, "b", 200.0), _band(tmp_path, "c", 250.0)]
    dv = default_view_dict(mode="rgb", r="a", g="b", b="c")
    out = tmp_path / "fitsgl.json"
    with pytest.warns(UserWarning, match="spans grid groups"):
        build_fitsgl_config(bands, out, name="set", default_view=dv)
    # It still emits (the viewer falls back); the warning is advisory.
    assert out.is_file()
