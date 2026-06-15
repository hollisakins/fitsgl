"""Tests for the manifest schema and IO."""

import json

from astropy.io import fits

from fitsgl.manifest import (
    HEADER_VERSION,
    MANIFEST_VERSION,
    LevelInfo,
    Manifest,
    SupertileInfo,
    read_manifest,
    write_header,
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
                supertiles=[
                    SupertileInfo(filename="mosaic_z0.fits.fz", tile_origin=[0, 0], tile_count=[4, 4])
                ],
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
                supertiles=[
                    SupertileInfo(filename="mosaic_z1.fits.fz", tile_origin=[0, 0], tile_count=[2, 2])
                ],
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
        "supertiles",
    }
    assert lvl0["compression"] == "GZIP_2"
    assert lvl0["lossless"] is True
    assert lvl0["supertiles"] == [
        {"filename": "mosaic_z0.fits.fz", "tile_origin": [0, 0], "tile_count": [4, 4]}
    ]


def test_from_dict_v1_shim_synthesizes_one_supertile():
    """A legacy v1 level (no `supertiles`) reads back as one full-grid supertile."""
    v1 = {
        "z": 0,
        "filename": "m_z0.fits.fz",
        "compression": "RICE_1",
        "lossless": False,
        "shape": [1024, 768],
        "fpack_tile_count": [3, 4],  # [n_tiles_y, n_tiles_x]
        "pixel_scale_arcsec": 0.03,
        "wcs": {},
    }
    lvl = LevelInfo.from_dict(v1)
    # tile_count is [n_tiles_x, n_tiles_y] = [4, 3]
    assert lvl.supertiles == [
        SupertileInfo(filename="m_z0.fits.fz", tile_origin=[0, 0], tile_count=[4, 3])
    ]


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


def test_write_header_sidecar(tmp_path):
    h = fits.Header()
    h["SIMPLE"] = True
    h["BITPIX"] = -32
    h["NAXIS"] = 2
    h["BUNIT"] = ("MJy/sr", "surface brightness unit")
    h["BLANK"] = None  # an undefined-value card -> null
    h.add_history("processed by fitsgl test")
    h.add_comment("a comment card")

    p = tmp_path / "header.json"
    write_header(p, h, source_file="thing.fits")

    raw = json.loads(p.read_text())  # parses => valid strict JSON (no NaN/Infinity)
    assert raw["version"] == HEADER_VERSION
    assert raw["source_file"] == "thing.fits"
    cards = {c["keyword"]: c for c in raw["cards"]}
    assert cards["BITPIX"]["value"] == -32
    assert cards["BUNIT"]["value"] == "MJy/sr"
    assert cards["BUNIT"]["comment"] == "surface brightness unit"
    assert cards["BLANK"]["value"] is None
    # COMMENT/HISTORY cards are preserved in order with their text in `value`.
    assert any(c["keyword"] == "HISTORY" for c in raw["cards"])
    assert any(c["keyword"] == "COMMENT" for c in raw["cards"])
