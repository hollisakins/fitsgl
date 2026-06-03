"""Tests for the pure deploy classifier + diff (deploy_plan.py).

No network, no boto3 — exercises classification, cache-control assignment, the
manifest round-trip, and the incremental diff (including the two supertile-era
behaviors: orphan deletion and purge batching) entirely on tmp_path fixtures.
"""

import json

import pytest

from pyramid_gen.deploy_plan import (
    ASSET_MAX_AGE,
    CLASS_ASSET,
    CLASS_POINTER,
    CLASS_TILE,
    DEFAULT_SWR_GRACE,
    DEFAULT_TILE_MAX_AGE,
    DEPLOY_MANIFEST_NAME,
    PURGE_URLS_PER_CALL,
    DeployFile,
    DeployManifest,
    build_deploy_manifest,
    cache_control_for,
    chunk_purge_urls,
    classify_file,
    diff_manifests,
    read_deploy_manifest,
    write_deploy_manifest,
)


# ---------------------------------------------------------------- classification


@pytest.mark.parametrize(
    "path,expected",
    [
        ("f444w/img_z0.fits.fz", CLASS_TILE),
        ("f444w/img_z0_0_1.fits.fz", CLASS_TILE),  # a supertile chunk
        ("FOO/BAR_Z2.FITS.FZ", CLASS_TILE),  # case-insensitive
        ("fitsgl.json", CLASS_POINTER),
        ("f444w/manifest.json", CLASS_POINTER),
        ("catalog.csv", CLASS_POINTER),
        ("index.html", CLASS_POINTER),  # entry must be fresh, not an immutable asset
        ("assets/index-abc123.js", CLASS_ASSET),
        ("assets/worker-deadbeef.js", CLASS_ASSET),
        ("assets/index-abc123.css", CLASS_ASSET),
        # `assets/` is matched case-sensitively: a band named `Assets`/`ASSETS`
        # (case-preserving slug) must NOT have its mutable manifest frozen immutable.
        ("Assets/manifest.json", CLASS_POINTER),
        ("ASSETS/img_z0.fits.fz", CLASS_TILE),  # .fits.fz still wins (checked first)
    ],
)
def test_classify_file(path, expected):
    assert classify_file(path) == expected


def test_cache_control_per_class():
    assert cache_control_for(CLASS_TILE) == (
        f"public, max-age={DEFAULT_TILE_MAX_AGE}, stale-while-revalidate={DEFAULT_SWR_GRACE}"
    )
    assert cache_control_for(CLASS_ASSET) == f"public, max-age={ASSET_MAX_AGE}, immutable"
    assert cache_control_for(CLASS_POINTER) == "public, no-cache"
    # No s-maxage on tiles (it would disable stale-while-revalidate — DP4).
    assert "s-maxage" not in cache_control_for(CLASS_TILE)


def test_cache_control_custom_tile_window():
    assert cache_control_for(CLASS_TILE, tile_max_age=86400, swr_grace=3600) == (
        "public, max-age=86400, stale-while-revalidate=3600"
    )


# ---------------------------------------------------------------- fixture builder


def make_dataset(tmp_path, *, tiles=("f444w/img_z0.fits.fz",), with_catalog=False, with_site=True):
    """Write a minimal but structurally-real built dataset under tmp_path."""
    root = tmp_path / "cosmos-web"
    root.mkdir()
    (root / "fitsgl.json").write_text(json.dumps({"schemaVersion": 1, "dataset": {"name": "cosmos-web"}}))
    bands = sorted({t.split("/")[0] for t in tiles if "/" in t})
    for band in bands:
        (root / band).mkdir(exist_ok=True)
        (root / band / "manifest.json").write_text('{"version": 2}')
    for i, t in enumerate(tiles):
        p = root / t
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(f"tile-bytes-{i}".encode())
    if with_catalog:
        (root / "catalog.csv").write_text("ra,dec\n1,2\n")
    if with_site:
        (root / "index.html").write_text("<!doctype html><script src=./assets/index-abc.js></script>")
        (root / "assets").mkdir()
        (root / "assets" / "index-abc.js").write_text("console.log(1)")
        (root / "assets" / "index-abc.css").write_text("body{}")
    return root


# ---------------------------------------------------------------- build_deploy_manifest


def test_build_manifest_classifies_and_hashes(tmp_path):
    root = make_dataset(tmp_path, tiles=("f444w/img_z0.fits.fz", "f444w/img_z1.fits.fz"), with_catalog=True)
    m = build_deploy_manifest(root)
    assert m.dataset == "cosmos-web"
    by = m.by_path()

    assert by["f444w/img_z0.fits.fz"].cls == CLASS_TILE
    assert by["f444w/img_z0.fits.fz"].content_type == "application/octet-stream"
    assert by["f444w/img_z0.fits.fz"].cache_control.startswith("public, max-age=")
    assert by["fitsgl.json"].cls == CLASS_POINTER
    assert by["fitsgl.json"].content_type == "application/json"
    assert by["fitsgl.json"].cache_control == "public, no-cache"
    assert by["f444w/manifest.json"].cls == CLASS_POINTER
    assert by["catalog.csv"].content_type == "text/csv"
    assert by["index.html"].cls == CLASS_POINTER
    assert by["index.html"].content_type == "text/html"
    assert by["assets/index-abc.js"].cls == CLASS_ASSET
    assert by["assets/index-abc.js"].content_type == "text/javascript"
    assert "immutable" in by["assets/index-abc.js"].cache_control

    # Hashes/sizes are real and the files are sorted by path.
    z0 = by["f444w/img_z0.fits.fz"]
    assert len(z0.sha256) == 64 and z0.size == len(b"tile-bytes-0")
    assert [f.path for f in m.files] == sorted(f.path for f in m.files)


def test_build_manifest_honors_custom_tile_window(tmp_path):
    root = make_dataset(tmp_path)
    m = build_deploy_manifest(root, tile_max_age=3600, swr_grace=60)
    tile = m.by_path()["f444w/img_z0.fits.fz"]
    assert tile.cache_control == "public, max-age=3600, stale-while-revalidate=60"


def test_build_manifest_dataset_name_override(tmp_path):
    root = make_dataset(tmp_path)  # dir is named "cosmos-web"
    assert build_deploy_manifest(root, dataset_name="other-name").dataset == "other-name"


def test_build_manifest_excludes_ledger_and_dotfiles(tmp_path):
    root = make_dataset(tmp_path)
    (root / DEPLOY_MANIFEST_NAME).write_text("{}")  # must be excluded from its own diff set
    (root / ".DS_Store").write_bytes(b"\x00")
    (root / "f444w" / ".hidden").write_text("x")
    paths = {f.path for f in build_deploy_manifest(root).files}
    assert DEPLOY_MANIFEST_NAME not in paths
    assert not any(".DS_Store" in p or ".hidden" in p for p in paths)


def test_build_manifest_requires_built_dataset(tmp_path):
    empty = tmp_path / "not-built"
    empty.mkdir()
    (empty / "stray.fits.fz").write_bytes(b"x")
    with pytest.raises(FileNotFoundError, match="fitsgl.json"):
        build_deploy_manifest(empty)


def test_build_manifest_missing_dir(tmp_path):
    with pytest.raises(FileNotFoundError, match="not a directory"):
        build_deploy_manifest(tmp_path / "nope")


def test_manifest_roundtrips_through_json(tmp_path):
    root = make_dataset(tmp_path, with_catalog=True)
    m = build_deploy_manifest(root)
    out = tmp_path / DEPLOY_MANIFEST_NAME
    write_deploy_manifest(out, m)
    back = read_deploy_manifest(out)
    assert back.to_dict() == m.to_dict()
    # The on-disk form uses the documented camelCase + `class` keys (§6).
    raw = json.loads(out.read_text())
    assert raw["schemaVersion"] == 1 and raw["dataset"] == "cosmos-web"
    f0 = raw["files"][0]
    assert set(f0) == {"path", "class", "contentType", "cacheControl", "sha256", "size"}


# ---------------------------------------------------------------- diff


def test_diff_first_deploy_uploads_all_purges_none(tmp_path):
    m = build_deploy_manifest(make_dataset(tmp_path, with_catalog=True))
    d = diff_manifests(None, m)
    assert {f.path for f in d.upload} == {f.path for f in m.files}
    assert d.purge == []  # nothing was ever cached
    assert d.delete == []
    assert d.unchanged == []
    assert not d.is_noop


def test_diff_identical_is_all_unchanged(tmp_path):
    m = build_deploy_manifest(make_dataset(tmp_path))
    d = diff_manifests(m, m)
    assert d.upload == [] and d.purge == [] and d.delete == []
    assert {f.path for f in d.unchanged} == {f.path for f in m.files}
    assert d.is_noop


def test_diff_changed_tile_uploads_and_purges(tmp_path):
    root = make_dataset(tmp_path)
    remote = build_deploy_manifest(root)
    (root / "f444w" / "img_z0.fits.fz").write_bytes(b"NEW tile bytes, different length")
    local = build_deploy_manifest(root)
    d = diff_manifests(remote, local)
    assert [f.path for f in d.upload] == ["f444w/img_z0.fits.fz"]
    assert d.purge == ["f444w/img_z0.fits.fz"]  # stable URL, changed bytes → evict edge
    assert d.upload_bytes == len(b"NEW tile bytes, different length")  # byte total for the §5.1 prompt


def test_diff_metadata_only_change_reuploads_and_purges_tile(tmp_path):
    # Same bytes, lowered cache window (a producer who now republishes daily). A
    # hash-only diff would silently discard the new window; the header diff catches it.
    root = make_dataset(tmp_path)
    remote = build_deploy_manifest(root, tile_max_age=604800, swr_grace=2592000)
    local = build_deploy_manifest(root, tile_max_age=86400, swr_grace=3600)
    d = diff_manifests(remote, local)
    assert not d.is_noop
    assert [f.path for f in d.upload] == ["f444w/img_z0.fits.fz"]
    assert d.purge == ["f444w/img_z0.fits.fz"]  # edge must re-read the new Cache-Control


def test_diff_changed_pointer_uploads_but_does_not_purge(tmp_path):
    root = make_dataset(tmp_path)
    remote = build_deploy_manifest(root)
    (root / "fitsgl.json").write_text(json.dumps({"schemaVersion": 1, "dataset": {"name": "cosmos-web", "x": 1}}))
    local = build_deploy_manifest(root)
    d = diff_manifests(remote, local)
    assert [f.path for f in d.upload] == ["fitsgl.json"]
    assert d.purge == []  # pointers are no-cache / origin-served, never edge-stale


def test_diff_new_tile_uploads_without_purge(tmp_path):
    root = make_dataset(tmp_path, tiles=("f444w/img_z0.fits.fz",))
    remote = build_deploy_manifest(root)
    (root / "f444w" / "img_z1.fits.fz").write_bytes(b"a new deeper level")
    local = build_deploy_manifest(root)
    d = diff_manifests(remote, local)
    assert [f.path for f in d.upload] == ["f444w/img_z1.fits.fz"]
    assert d.purge == []  # a brand-new URL has no edge entry to evict


def test_diff_orphan_supertile_is_deleted(tmp_path):
    # Re-tiling churns supertile filenames: a level that was 2 chunks becomes 1.
    root = make_dataset(tmp_path, tiles=("f444w/img_z0_0_0.fits.fz", "f444w/img_z0_0_1.fits.fz"))
    remote = build_deploy_manifest(root)
    (root / "f444w" / "img_z0_0_1.fits.fz").unlink()
    (root / "f444w" / "img_z0.fits.fz").write_bytes(b"now one chunk")
    local = build_deploy_manifest(root)
    d = diff_manifests(remote, local)
    assert d.delete == ["f444w/img_z0_0_1.fits.fz"]  # orphan removed, not left to accumulate
    assert [f.path for f in d.upload] == ["f444w/img_z0.fits.fz"]
    # The orphan's R2 object is gone, but a warm edge copy could shadow the 404 →
    # purge it in the same pass (the deletion satisfies DP5's push→purge ordering).
    assert "f444w/img_z0_0_1.fits.fz" in d.purge


# ---------------------------------------------------------------- purge batching


def test_chunk_purge_urls_batches_under_cap():
    urls = [f"u{i}" for i in range(250)]
    batches = chunk_purge_urls(urls)
    assert len(batches) == 3  # 100 + 100 + 50
    assert all(len(b) <= PURGE_URLS_PER_CALL for b in batches)
    assert [u for b in batches for u in b] == urls  # order preserved, nothing dropped


def test_chunk_purge_urls_empty_and_custom_size():
    assert chunk_purge_urls([]) == []
    assert chunk_purge_urls(["a", "b", "c"], size=2) == [["a", "b"], ["c"]]
    with pytest.raises(ValueError):
        chunk_purge_urls(["a"], size=0)


def test_deployfile_from_dict_back_compat_shape():
    f = DeployFile(
        path="f444w/img_z0.fits.fz",
        cls=CLASS_TILE,
        content_type="application/octet-stream",
        cache_control="public, max-age=604800, stale-while-revalidate=2592000",
        sha256="deadbeef",
        size=42,
    )
    assert DeployFile.from_dict(f.to_dict()) == f
    m = DeployManifest(dataset="x", files=[f])
    assert DeployManifest.from_dict(m.to_dict()).files[0] == f


def test_manifest_from_dict_tolerates_missing_optional_keys(tmp_path):
    # The .get() defaults exist for legacy / hand-edited ledgers: only `dataset`
    # is required; a missing schemaVersion / files falls back cleanly.
    from pyramid_gen.deploy_plan import DEPLOY_MANIFEST_SCHEMA

    m = DeployManifest.from_dict({"dataset": "x"})
    assert m.dataset == "x" and m.schema_version == DEPLOY_MANIFEST_SCHEMA and m.files == []
