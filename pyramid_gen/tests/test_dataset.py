"""Tests for the dataset manifest writer + grid hash (M4, D9)."""

import json

import pytest

from pyramid_gen.dataset import (
    DATASET_VERSION,
    DatasetBand,
    DatasetManifest,
    band_from_manifest,
    build_dataset,
    derive_cd,
    grid_hash,
    read_dataset,
)
from pyramid_gen.manifest import LevelInfo, Manifest, write_manifest

# A reference TAN WCS in the PC+CDELT form the pipeline emits (no CD keys).
_SCALE = 8.333e-6
_PC_CDELT_WCS = {
    "CTYPE1": "RA---TAN",
    "CTYPE2": "DEC--TAN",
    "CUNIT1": "deg",
    "CUNIT2": "deg",
    "CRPIX1": 256.5,
    "CRPIX2": 256.5,
    "CRVAL1": 150.0,
    "CRVAL2": 2.2,
    "PC1_1": -1.0,
    "PC2_2": 1.0,
    "CDELT1": _SCALE,
    "CDELT2": _SCALE,
    "RADESYS": "ICRS",
}
# The same physical grid expressed as an explicit CD matrix.
_CD_WCS = {
    "CTYPE1": "RA---TAN",
    "CTYPE2": "DEC--TAN",
    "CUNIT1": "deg",
    "CUNIT2": "deg",
    "CRPIX1": 256.5,
    "CRPIX2": 256.5,
    "CRVAL1": 150.0,
    "CRVAL2": 2.2,
    "CD1_1": -_SCALE,
    "CD1_2": 0.0,
    "CD2_1": 0.0,
    "CD2_2": _SCALE,
    "RADESYS": "ICRS",
}
_SHAPE = [512, 512]


def _fake_manifest(wcs=None, shape=None, stem="band") -> Manifest:
    """A minimal single-level manifest carrying a z=0 WCS (no files needed)."""
    wcs = dict(_PC_CDELT_WCS if wcs is None else wcs)
    shape = list(_SHAPE if shape is None else shape)
    z0 = LevelInfo(
        z=0,
        filename=f"{stem}_z0.fits.fz",
        compression="GZIP_2",
        lossless=True,
        shape=shape,
        fpack_tile_count=[2, 2],
        pixel_scale_arcsec=0.03,
        wcs=wcs,
    )
    return Manifest(source_file=f"{stem}.fits", native_shape=shape, n_levels=0, levels=[z0])


# --------------------------------------------------------------------------- #
# grid_hash
# --------------------------------------------------------------------------- #
def test_derive_cd_matches_for_both_encodings():
    assert derive_cd(_PC_CDELT_WCS) == derive_cd(_CD_WCS)
    assert derive_cd(_PC_CDELT_WCS) == (-_SCALE, 0.0, 0.0, _SCALE)


def test_grid_hash_is_representation_invariant():
    # A CD-matrix header and the equivalent PC+CDELT header hash identically:
    # the hash canonicalizes the DERIVED transform, not the raw keywords.
    assert grid_hash(_PC_CDELT_WCS, _SHAPE) == grid_hash(_CD_WCS, _SHAPE)


def test_grid_hash_is_deterministic_and_pinned():
    h = grid_hash(_PC_CDELT_WCS, _SHAPE)
    assert h == grid_hash(_PC_CDELT_WCS, _SHAPE)  # stable across calls
    # Golden: a change to the canonicalization/hash algorithm must be deliberate.
    assert h == "cd26eeba"


def test_grid_hash_rejects_half_pixel_offset():
    shifted = dict(_PC_CDELT_WCS, CRPIX1=257.0)  # half-pixel offset
    assert grid_hash(shifted, _SHAPE) != grid_hash(_PC_CDELT_WCS, _SHAPE)


def test_grid_hash_rejects_off_by_one_shape():
    assert grid_hash(_PC_CDELT_WCS, [512, 511]) != grid_hash(_PC_CDELT_WCS, _SHAPE)


def test_grid_hash_rejects_rotation():
    # A rolled CD (off-diagonal terms) is a different grid.
    rolled = dict(_CD_WCS, CD1_2=_SCALE * 0.5, CD2_1=_SCALE * 0.5)
    assert grid_hash(rolled, _SHAPE) != grid_hash(_CD_WCS, _SHAPE)


# --------------------------------------------------------------------------- #
# build_dataset / round-trip
# --------------------------------------------------------------------------- #
def test_build_dataset_round_trip(tmp_path):
    # Three same-grid band manifests in sibling subdirs.
    names = ["red", "green", "blue"]
    for name in names:
        d = tmp_path / name
        d.mkdir()
        write_manifest(d / "manifest.json", _fake_manifest(stem=name))

    out = tmp_path / "dataset.json"
    ds = build_dataset(
        [(name, tmp_path / name / "manifest.json") for name in names],
        out,
    )

    # Re-read from disk and confirm structure survives.
    disk = read_dataset(out)
    assert disk.version == DATASET_VERSION
    assert disk.to_dict() == ds.to_dict()
    assert [b.name for b in disk.bands] == names
    # Relative, '/'-separated, never absolute.
    for name, band in zip(names, disk.bands):
        assert band.path == f"{name}/manifest.json"
        assert not band.path.startswith("/")
    # Each band's grid params come from its z=0 level / native_shape.
    assert disk.bands[0].shape == _SHAPE
    assert disk.bands[0].grid_hash == grid_hash(_PC_CDELT_WCS, _SHAPE)
    # default_rgb defaults to the first three bands in order.
    assert disk.default_rgb == {"r": "red", "g": "green", "b": "blue"}


def test_build_dataset_honours_explicit_default_rgb(tmp_path):
    for name in ["a", "b", "c"]:
        d = tmp_path / name
        d.mkdir()
        write_manifest(d / "manifest.json", _fake_manifest(stem=name))
    out = tmp_path / "dataset.json"
    ds = build_dataset(
        [(n, tmp_path / n / "manifest.json") for n in ["a", "b", "c"]],
        out,
        default_rgb={"r": "c", "g": "b", "b": "a"},
    )
    assert ds.default_rgb == {"r": "c", "g": "b", "b": "a"}


def test_build_dataset_rejects_manifest_outside_dir(tmp_path):
    # A band manifest that is NOT under the dataset directory has no relative URL.
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    write_manifest(outside / "manifest.json", _fake_manifest(stem="x"))
    dataset_dir = tmp_path / "dataset"
    dataset_dir.mkdir()
    with pytest.raises(ValueError):
        build_dataset([("x", outside / "manifest.json")], dataset_dir / "dataset.json")


def test_band_from_manifest_uses_z0_grid():
    band = band_from_manifest("red", _fake_manifest(), "red/manifest.json")
    assert band.ctype1 == "RA---TAN"
    assert band.ctype2 == "DEC--TAN"
    assert band.crval == [150.0, 2.2]
    assert band.cd == [-_SCALE, 0.0, 0.0, _SCALE]
    assert band.shape == _SHAPE


def test_dataset_json_is_valid_json_with_expected_keys(tmp_path):
    write_manifest((tmp_path / "manifest.json"), _fake_manifest(stem="solo"))
    out = tmp_path / "dataset.json"
    build_dataset([("solo", tmp_path / "manifest.json")], out)
    obj = json.loads(out.read_text())
    assert obj["version"] == DATASET_VERSION
    assert set(obj.keys()) == {"version", "bands", "default_rgb"}
    band = obj["bands"][0]
    assert set(band.keys()) == {
        "name",
        "path",
        "ctype1",
        "ctype2",
        "shape",
        "crpix",
        "crval",
        "cd",
        "pixel_scale_arcsec",
        "grid_hash",
    }


def test_dataset_manifest_dataclass_defaults():
    m = DatasetManifest()
    assert m.version == DATASET_VERSION
    assert m.bands == []
    assert m.default_rgb is None


# --------------------------------------------------------------------------- #
# Writer contract: never ship a file the strict TS reader would reject.
# --------------------------------------------------------------------------- #
def _band(name: str) -> DatasetBand:
    return band_from_manifest(name, _fake_manifest(stem=name), f"{name}/manifest.json")


def test_default_rgb_validation_rejects_unknown_band():
    bands = [_band("a"), _band("b"), _band("c")]
    with pytest.raises(ValueError, match="unknown band"):
        DatasetManifest(bands=bands, default_rgb={"r": "a", "g": "b", "b": "nope"})


def test_default_rgb_validation_rejects_missing_or_extra_key():
    bands = [_band("a"), _band("b")]
    with pytest.raises(ValueError, match="keys r/g/b"):
        DatasetManifest(bands=bands, default_rgb={"r": "a", "g": "b"})  # missing b
    with pytest.raises(ValueError, match="keys r/g/b"):
        DatasetManifest(bands=bands, default_rgb={"r": "a", "g": "b", "b": "a", "x": "a"})


def test_default_rgb_validation_runs_on_read(tmp_path):
    # A hand-corrupted dataset.json with a dangling default_rgb is rejected on read
    # (symmetric with the TS validateDataset), not silently round-tripped.
    import json

    good = tmp_path / "dataset.json"
    write_manifest(tmp_path / "manifest.json", _fake_manifest(stem="a"))
    build_dataset([("a", tmp_path / "manifest.json")], good, default_rgb=None)
    obj = json.loads(good.read_text())
    obj["default_rgb"] = {"r": "a", "g": "ghost", "b": "a"}
    good.write_text(json.dumps(obj))
    with pytest.raises(ValueError, match="unknown band"):
        read_dataset(good)


def test_non_finite_pixel_scale_is_rejected_not_serialized():
    # A band manifest carrying a non-finite scale must fail at assembly, never
    # produce a bare `NaN` token that the browser's JSON.parse would reject.
    bad = _fake_manifest(stem="x")
    bad.levels[0].pixel_scale_arcsec = float("nan")
    with pytest.raises(ValueError, match="non-finite pixel_scale_arcsec"):
        band_from_manifest("x", bad, "x/manifest.json")
