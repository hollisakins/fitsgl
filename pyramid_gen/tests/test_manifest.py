"""Tests for the manifest schema and IO."""

import json

from pyramid_gen.manifest import (
    MANIFEST_VERSION,
    LevelInfo,
    Manifest,
    read_manifest,
    write_manifest,
)


def _example_manifest():
    return Manifest(
        source_file="mosaic.fits",
        native_shape=[1024, 1024],
        n_levels=2,
        fpack_tile_size=256,
        levels=[
            LevelInfo(
                z=0,
                filename="mosaic_z0.fits.fz",
                compression="GZIP_2",
                lossless=True,
                shape=[1024, 1024],
                fpack_tile_count=[4, 4],
                pixel_scale_arcsec=0.03,
                wcs={"CTYPE1": "RA---TAN", "CRPIX1": 512.5},
            ),
            LevelInfo(
                z=1,
                filename="mosaic_z1.fits.fz",
                compression="RICE_1",
                lossless=False,
                shape=[512, 512],
                fpack_tile_count=[2, 2],
                pixel_scale_arcsec=0.06,
                wcs={"CTYPE1": "RA---TAN", "CRPIX1": 256.25},
            ),
        ],
    )


def test_to_dict_schema():
    d = _example_manifest().to_dict()
    assert d["version"] == MANIFEST_VERSION
    assert d["source_file"] == "mosaic.fits"
    assert d["native_shape"] == [1024, 1024]
    assert d["fpack_tile_size"] == 256
    assert d["n_levels"] == 2
    assert len(d["levels"]) == 2
    lvl0 = d["levels"][0]
    assert set(lvl0) == {
        "z",
        "filename",
        "compression",
        "lossless",
        "shape",
        "fpack_tile_count",
        "pixel_scale_arcsec",
        "wcs",
    }
    assert lvl0["compression"] == "GZIP_2"
    assert lvl0["lossless"] is True


def test_roundtrip_dict():
    m = _example_manifest()
    m2 = Manifest.from_dict(m.to_dict())
    assert m2.to_dict() == m.to_dict()


def test_write_read(tmp_path):
    m = _example_manifest()
    p = tmp_path / "manifest.json"
    write_manifest(p, m)
    # File is valid JSON.
    with p.open() as f:
        raw = json.load(f)
    assert raw["n_levels"] == 2
    m2 = read_manifest(p)
    assert m2.to_dict() == m.to_dict()


def test_json_serializable():
    # Every field must survive json.dumps without a custom encoder.
    json.dumps(_example_manifest().to_dict())
