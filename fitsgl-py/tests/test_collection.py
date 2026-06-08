"""Tests for the collection landing-page emitter (collection.py) + the root deploy.

Pure logic over the filesystem; no network. The picker viewer copy needs the
vendored bundle (committed), so emit_collection tests are skipped if it is absent.
"""

import json

import pytest

from fitsgl.collection import (
    COLLECTION_MANIFEST_NAME,
    COLLECTION_SCHEMA_VERSION,
    COLLECTION_STAGING_DIR,
    build_collection,
    collection_field_entry,
    emit_collection,
)
from fitsgl.site import viewer_available


def build_field(root, prefix, *, title=None, bands=("a", "b"), with_center=True):
    """A minimal built field dir: fitsgl.json + a first-band manifest with a WCS."""
    d = root / prefix
    d.mkdir(parents=True, exist_ok=True)
    band_dirs = []
    for b in bands:
        (d / b).mkdir(exist_ok=True)
        band_dirs.append(b)
    cfg = {
        "schemaVersion": 1,
        "dataset": {
            "name": prefix,
            "bands": [{"name": b, "tiles": [f"{b}/manifest.json"]} for b in bands],
        },
    }
    if title is not None:
        cfg["dataset"]["title"] = title
    (d / "fitsgl.json").write_text(json.dumps(cfg))
    wcs = {"CRVAL1": 150.1163, "CRVAL2": 2.2007} if with_center else {}
    (d / bands[0] / "manifest.json").write_text(
        json.dumps({"version": 2, "levels": [{"z": 0, "wcs": wcs}]})
    )
    return d


# ---------------------------------------------------------------- field entries


def test_field_entry_from_built_dir(tmp_path):
    build_field(tmp_path, "cosmos", title="COSMOS", bands=("a", "b", "c"))
    entry = collection_field_entry("cosmos", tmp_path / "cosmos")
    assert entry == {
        "name": "cosmos",
        "title": "COSMOS",
        "bandCount": 3,
        "center": {"ra": 150.1163, "dec": 2.2007},
    }


def test_field_entry_title_override_wins(tmp_path):
    build_field(tmp_path, "cosmos", title="COSMOS")
    entry = collection_field_entry("cosmos", tmp_path / "cosmos", title_override="Override")
    assert entry["title"] == "Override"


def test_field_entry_title_falls_back_to_name(tmp_path):
    build_field(tmp_path, "egs", title=None)
    entry = collection_field_entry("egs", tmp_path / "egs")
    assert entry["title"] == "egs"


def test_field_entry_omits_center_when_wcs_missing(tmp_path):
    build_field(tmp_path, "egs", with_center=False)
    entry = collection_field_entry("egs", tmp_path / "egs")
    assert "center" not in entry
    assert entry["bandCount"] == 2  # still emitted


def test_field_entry_omits_center_on_unreadable_manifest(tmp_path):
    d = build_field(tmp_path, "egs")
    (d / "a" / "manifest.json").write_text("{ not json")
    entry = collection_field_entry("egs", d)
    assert "center" not in entry


def test_field_entry_none_when_not_built(tmp_path):
    (tmp_path / "egs").mkdir()  # dir exists but no fitsgl.json
    assert collection_field_entry("egs", tmp_path / "egs") is None


def test_field_entry_name_is_the_prefix_not_dataset_name(tmp_path):
    # the deploy prefix may differ from dataset.name; the card links to <prefix>/
    build_field(tmp_path, "cosmos")
    entry = collection_field_entry("cosmos-dr1", tmp_path / "cosmos")
    assert entry["name"] == "cosmos-dr1"


# -------------------------------------------------------------- build_collection


def test_build_collection_shape():
    obj = build_collection("survey", "The Survey", [{"name": "cosmos", "title": "C"}])
    assert obj["schemaVersion"] == COLLECTION_SCHEMA_VERSION
    assert obj["collection"] == {"name": "survey", "title": "The Survey"}
    assert obj["fields"] == [{"name": "cosmos", "title": "C"}]


def test_build_collection_omits_absent_title():
    obj = build_collection("survey", None, [])
    assert obj["collection"] == {"name": "survey"}
    assert "title" not in obj["collection"]


# ------------------------------------------------------------------ emit (staging)


@pytest.mark.skipif(not viewer_available(), reason="vendored viewer bundle not built")
def test_emit_collection_writes_dotdir_and_picker(tmp_path):
    build_field(tmp_path, "cosmos", title="COSMOS")
    build_field(tmp_path, "egs")
    result = emit_collection(
        tmp_path,
        name="survey",
        title="The Survey",
        field_specs=[("cosmos", tmp_path / "cosmos", None), ("egs", tmp_path / "egs", None)],
    )
    staging = tmp_path / COLLECTION_STAGING_DIR
    assert result.staging_dir == staging
    assert (staging / COLLECTION_MANIFEST_NAME).is_file()
    assert (staging / "index.html").is_file()  # picker viewer copied in
    assert (staging / "assets").is_dir()
    obj = json.loads((staging / COLLECTION_MANIFEST_NAME).read_text())
    assert [f["name"] for f in obj["fields"]] == ["cosmos", "egs"]
    assert result.skipped == []
    # the field dirs themselves are untouched
    assert (tmp_path / "cosmos" / "fitsgl.json").is_file()


@pytest.mark.skipif(not viewer_available(), reason="vendored viewer bundle not built")
def test_emit_collection_skips_unbuilt_field(tmp_path):
    build_field(tmp_path, "cosmos")
    (tmp_path / "egs").mkdir()  # declared but not built
    with pytest.warns(UserWarning, match="not built"):
        result = emit_collection(
            tmp_path,
            name="survey",
            title=None,
            field_specs=[("cosmos", tmp_path / "cosmos", None), ("egs", tmp_path / "egs", None)],
        )
    assert result.skipped == ["egs"]
    obj = json.loads((tmp_path / COLLECTION_STAGING_DIR / COLLECTION_MANIFEST_NAME).read_text())
    assert [f["name"] for f in obj["fields"]] == ["cosmos"]
