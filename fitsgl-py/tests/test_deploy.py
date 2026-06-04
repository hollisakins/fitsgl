"""Tests for the deploy engine (deploy.py).

The R2/Cloudflare I/O sits behind the DeployTarget/Purger protocols, so the §5.1
orchestration is exercised end-to-end against in-memory fakes — no boto3, no
network. Only the real adapters' factories (credential/config plumbing) and the
purge batching are tested directly.
"""

import json
import os
from pathlib import Path

import pytest

from fitsgl.deploy import (
    CloudflarePurge,
    DeployConfig,
    DeployError,
    DeployResult,
    R2Target,
    deploy_dataset,
    object_key,
    public_url_for,
)
from fitsgl.deploy_plan import CLASS_TILE, DEPLOY_MANIFEST_NAME, DeployDiff, DeployFile, DeployManifest, build_deploy_manifest
from fitsgl.verify import FAIL, VerifyReport


# ------------------------------------------------------------------ fixtures/fakes


def make_dataset(tmp_path, *, tiles=("f444w/img_z0.fits.fz", "f444w/img_z1.fits.fz")):
    root = tmp_path / "cosmos-web"
    root.mkdir()
    (root / "fitsgl.json").write_text(json.dumps({"schemaVersion": 1, "dataset": {"name": "cosmos-web"}}))
    for band in sorted({t.split("/")[0] for t in tiles if "/" in t}):
        (root / band).mkdir(exist_ok=True)
        (root / band / "manifest.json").write_text('{"version": 2}')
    for i, t in enumerate(tiles):
        p = root / t
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(f"tile-bytes-{i}".encode())
    (root / "index.html").write_text("<!doctype html><script src=./assets/index-abc.js></script>")
    (root / "assets").mkdir()
    (root / "assets" / "index-abc.js").write_text("console.log(1)")
    return root


class FakeTarget:
    """In-memory DeployTarget: stores objects + records the op order."""

    def __init__(self, *, fail_on=None):
        self.objects: dict[str, bytes] = {}
        self.meta: dict[str, tuple[str, str]] = {}
        self.ops: list[tuple[str, str | None]] = []
        self.cors: tuple[list[str], list[str], list[str]] | None = None
        self.fail_on = fail_on  # raise in put_file when this substring is in the key

    def get_bytes(self, key):
        self.ops.append(("get", key))
        return self.objects.get(key)

    def put_file(self, key, path, *, content_type, cache_control):
        if self.fail_on is not None and self.fail_on in key:
            raise RuntimeError(f"simulated upload failure for {key}")
        self.ops.append(("put_file", key))
        self.objects[key] = Path(path).read_bytes()
        self.meta[key] = (content_type, cache_control)

    def put_bytes(self, key, data, *, content_type, cache_control):
        self.ops.append(("put_bytes", key))
        self.objects[key] = data
        self.meta[key] = (content_type, cache_control)

    def delete(self, key):
        self.ops.append(("delete", key))
        self.objects.pop(key, None)
        self.meta.pop(key, None)

    def put_cors(self, origins, methods, headers):
        self.ops.append(("cors", None))
        self.cors = (origins, methods, headers)


class FakePurger:
    def __init__(self, fail=False):
        self.batches: list[list[str]] = []
        self.fail = fail

    def purge(self, urls):
        if self.fail:
            raise DeployError("purge boom")
        self.batches.append(list(urls))


def cfg(**kw):
    base = dict(bucket="cosmos-web", endpoint="https://acct.r2.cloudflarestorage.com",
                public_url="https://data.example.org/cosmos-web")
    base.update(kw)
    return DeployConfig(**base)


# ---------------------------------------------------------------- pure helpers


def test_object_key_with_and_without_prefix():
    assert object_key("", "f444w/img_z0.fits.fz") == "f444w/img_z0.fits.fz"
    assert object_key("cosmos", "f444w/img_z0.fits.fz") == "cosmos/f444w/img_z0.fits.fz"
    assert object_key("/cosmos/", "f444w/x.fits.fz") == "cosmos/f444w/x.fits.fz"  # slashes trimmed


def test_public_url_for():
    assert public_url_for("https://d.org/ds", "f444w/x.fits.fz") == "https://d.org/ds/f444w/x.fits.fz"
    assert public_url_for("https://d.org/ds/", "/f444w/x.fits.fz") == "https://d.org/ds/f444w/x.fits.fz"


# ---------------------------------------------------------------- first deploy


def test_first_deploy_uploads_all_sets_cors_writes_ledger_last(tmp_path):
    root = make_dataset(tmp_path)
    t = FakeTarget()
    result = deploy_dataset(root, cfg(), t, run_verify=False)

    # Every dataset file was uploaded; nothing deleted; nothing purged (first deploy).
    local = build_deploy_manifest(root)
    assert set(result.uploaded) == {f.path for f in local.files}
    assert result.deleted == [] and result.purged == []

    # CORS was set (DP8) with explicit "range" (R2 rejects "*").
    assert t.cors == (["*"], ["GET", "HEAD"], ["range"])

    # The ledger is written LAST (its presence ⇒ the deploy succeeded), as in-memory bytes.
    ledger_key = DEPLOY_MANIFEST_NAME
    assert t.ops[-1] == ("put_bytes", ledger_key)
    assert t.meta[ledger_key] == ("application/json", "public, no-cache")

    # Tiles upload before pointers/assets (a fresh no-cache manifest must not point
    # at a not-yet-uploaded tile).
    puts = [key for op, key in t.ops if op == "put_file"]
    last_tile = max(i for i, k in enumerate(puts) if k.endswith(".fits.fz"))
    first_nontile = min(i for i, k in enumerate(puts) if not k.endswith(".fits.fz"))
    assert last_tile < first_nontile


def test_per_object_headers_match_the_classifier(tmp_path):
    root = make_dataset(tmp_path)
    t = FakeTarget()
    deploy_dataset(root, cfg(), t, run_verify=False)
    assert t.meta["f444w/img_z0.fits.fz"][0] == "application/octet-stream"
    assert t.meta["f444w/img_z0.fits.fz"][1].startswith("public, max-age=")
    assert t.meta["fitsgl.json"] == ("application/json", "public, no-cache")
    assert "immutable" in t.meta["assets/index-abc.js"][1]


def test_tile_max_age_flows_through_to_cache_control(tmp_path):
    root = make_dataset(tmp_path)
    t = FakeTarget()
    deploy_dataset(root, cfg(tile_max_age=86400), t, run_verify=False)
    assert t.meta["f444w/img_z0.fits.fz"][1] == "public, max-age=86400, stale-while-revalidate=2592000"


def test_verify_is_run_with_the_public_url(tmp_path):
    root = make_dataset(tmp_path)
    seen = {}

    def fake_verify(url):
        seen["url"] = url
        return VerifyReport(base_url=url)

    result = deploy_dataset(root, cfg(), FakeTarget(), run_verify=True, verify_fn=fake_verify)
    assert seen["url"] == "https://data.example.org/cosmos-web"
    assert result.verify_report is not None and result.verify_report.base_url == seen["url"]


def test_verify_runs_by_default(tmp_path):
    # run_verify defaults to True — omit it and confirm the checker is still invoked.
    root = make_dataset(tmp_path)
    called = []
    deploy_dataset(root, cfg(), FakeTarget(), verify_fn=lambda u: called.append(u) or VerifyReport(base_url=u))
    assert called == ["https://data.example.org/cosmos-web"]


# ---------------------------------------------------------------- incremental


def test_second_deploy_with_no_changes_uploads_nothing(tmp_path):
    root = make_dataset(tmp_path)
    t = FakeTarget()
    deploy_dataset(root, cfg(), t, run_verify=False)  # populates the fake bucket + ledger
    again = deploy_dataset(root, cfg(), t, run_verify=False)
    assert again.diff.is_noop
    assert again.uploaded == [] and again.deleted == [] and again.purged == []


def test_changed_tile_is_reuploaded_and_purged(tmp_path):
    root = make_dataset(tmp_path)
    t = FakeTarget()
    deploy_dataset(root, cfg(), t, run_verify=False)
    (root / "f444w" / "img_z0.fits.fz").write_bytes(b"CHANGED tile bytes, new length here")
    purger = FakePurger()
    result = deploy_dataset(root, cfg(), t, purger=purger, run_verify=False)
    assert result.uploaded == ["f444w/img_z0.fits.fz"]
    assert result.purged == ["https://data.example.org/cosmos-web/f444w/img_z0.fits.fz"]
    assert purger.batches == [["https://data.example.org/cosmos-web/f444w/img_z0.fits.fz"]]


def test_orphaned_supertile_is_deleted(tmp_path):
    root = make_dataset(tmp_path, tiles=("f444w/img_z0_0_0.fits.fz", "f444w/img_z0_0_1.fits.fz"))
    t = FakeTarget()
    deploy_dataset(root, cfg(), t, run_verify=False)
    (root / "f444w" / "img_z0_0_1.fits.fz").unlink()  # re-tile orphans this file
    (root / "f444w" / "img_z0.fits.fz").write_bytes(b"now one chunk")
    purger = FakePurger()
    result = deploy_dataset(root, cfg(), t, purger=purger, run_verify=False)
    assert result.deleted == ["f444w/img_z0_0_1.fits.fz"]
    assert ("delete", "f444w/img_z0_0_1.fits.fz") in t.ops
    assert "f444w/img_z0_0_1.fits.fz" not in t.objects  # gone from the bucket
    # the orphan's URL is purged too (a warm edge copy could otherwise shadow the 404)
    assert "https://data.example.org/cosmos-web/f444w/img_z0_0_1.fits.fz" in result.purged


def test_unreadable_prior_ledger_falls_back_to_full_upload(tmp_path):
    root = make_dataset(tmp_path)
    t = FakeTarget()
    t.objects[DEPLOY_MANIFEST_NAME] = b"not json{{{"  # corrupt ledger
    result = deploy_dataset(root, cfg(), t, run_verify=False)
    local = build_deploy_manifest(root)
    assert set(result.uploaded) == {f.path for f in local.files}  # treated as first deploy


def test_non_dict_json_ledger_falls_back_to_full_upload(tmp_path):
    # A legal-but-non-object body (e.g. a truncated upload leaving `null`) must fall
    # back to a full upload, not crash with AttributeError.
    root = make_dataset(tmp_path)
    t = FakeTarget()
    t.objects[DEPLOY_MANIFEST_NAME] = b"null"
    result = deploy_dataset(root, cfg(), t, run_verify=False)
    assert set(result.uploaded) == {f.path for f in build_deploy_manifest(root).files}


def test_upload_failure_aborts_before_writing_the_ledger(tmp_path):
    # The load-bearing incremental-sync invariant: a mid-upload failure must NOT write
    # the success ledger, so the next deploy re-diffs against the old state and retries.
    root = make_dataset(tmp_path)
    t = FakeTarget(fail_on="img_z1.fits.fz")
    with pytest.raises(RuntimeError, match="simulated upload failure"):
        deploy_dataset(root, cfg(), t, run_verify=False)
    assert DEPLOY_MANIFEST_NAME not in t.objects  # ledger NOT written → no false success
    assert not any(op == "put_bytes" for op, _ in t.ops)


def test_purge_failure_aborts_before_the_ledger_and_self_heals(tmp_path):
    root = make_dataset(tmp_path)
    t = FakeTarget()
    deploy_dataset(root, cfg(), t, run_verify=False)  # v1 deployed, ledger written
    (root / "f444w" / "img_z0.fits.fz").write_bytes(b"v2 bytes, different length here")
    ledger_v1 = t.objects[DEPLOY_MANIFEST_NAME]

    # A purge that fails must propagate AND leave the ledger at v1 (not the new hashes),
    # so the change isn't masked as "already deployed".
    with pytest.raises(DeployError, match="purge boom"):
        deploy_dataset(root, cfg(), t, purger=FakePurger(fail=True), run_verify=False)
    assert t.objects[DEPLOY_MANIFEST_NAME] == ledger_v1  # ledger untouched (still v1)

    # Next deploy with a working purger self-heals: the change is re-detected + re-purged.
    purger = FakePurger()
    again = deploy_dataset(root, cfg(), t, purger=purger, run_verify=False)
    assert again.uploaded == ["f444w/img_z0.fits.fz"]
    assert purger.batches == [["https://data.example.org/cosmos-web/f444w/img_z0.fits.fz"]]
    assert t.objects[DEPLOY_MANIFEST_NAME] != ledger_v1  # now advanced to v2


# ------------------------------------------------------------------- prefix


def test_prefix_namespaces_keys_but_not_purge_urls(tmp_path):
    root = make_dataset(tmp_path)
    t = FakeTarget()
    deploy_dataset(root, cfg(prefix="cosmos"), t, run_verify=False)
    # Keys are namespaced under the prefix...
    assert "cosmos/f444w/img_z0.fits.fz" in t.objects
    assert "cosmos/" + DEPLOY_MANIFEST_NAME in t.objects
    # ...but the public URL (and thus a future purge URL) is independent of it.
    (root / "f444w" / "img_z0.fits.fz").write_bytes(b"changed-now")
    purger = FakePurger()
    deploy_dataset(root, cfg(prefix="cosmos"), t, purger=purger, run_verify=False)
    assert purger.batches == [["https://data.example.org/cosmos-web/f444w/img_z0.fits.fz"]]


# ------------------------------------------------------------------- dry run


def test_dry_run_makes_no_writes(tmp_path):
    root = make_dataset(tmp_path)
    t = FakeTarget()
    seen = []
    result = deploy_dataset(root, cfg(), t, run_verify=True, verify_fn=lambda u: seen.append(u),
                            dry_run=True)
    assert result.dry_run and result.uploaded == [] and result.purged == []
    assert result.diff.upload  # the plan was computed
    # No mutating ops, and verify is NOT run on a dry run.
    assert not any(op in ("put_file", "put_bytes", "delete", "cors") for op, _ in t.ops)
    assert seen == []


# ---------------------------------------------------------- purge-skip warning


def test_no_purger_skips_purge_with_warning(tmp_path):
    root = make_dataset(tmp_path)
    t = FakeTarget()
    deploy_dataset(root, cfg(), t, run_verify=False)
    (root / "f444w" / "img_z0.fits.fz").write_bytes(b"changed bytes here now")
    logs: list[str] = []
    result = deploy_dataset(root, cfg(), t, purger=None, run_verify=False, on_progress=logs.append)
    assert result.uploaded == ["f444w/img_z0.fits.fz"]
    assert result.purged == []  # no purger → skipped
    assert any("skipping edge purge" in m for m in logs)


# --------------------------------------------------------- CloudflarePurge unit


def test_cloudflare_purge_batches_under_100():
    posted: list[dict] = []

    def fake_post(url, data, headers):
        posted.append({"url": url, "body": json.loads(data), "auth": headers["Authorization"]})
        return {"success": True}

    purger = CloudflarePurge("zone123", "tok_abc", post=fake_post)
    purger.purge([f"https://d.org/t{i}.fits.fz" for i in range(250)])
    assert [len(p["body"]["files"]) for p in posted] == [100, 100, 50]  # batched ≤100/call
    assert all("zone123" in p["url"] for p in posted)
    assert posted[0]["auth"] == "Bearer tok_abc"


def test_cloudflare_purge_raises_on_api_failure():
    purger = CloudflarePurge("z", "t", post=lambda u, d, h: {"success": False, "errors": [{"message": "bad"}]})
    with pytest.raises(DeployError, match="purge failed"):
        purger.purge(["https://d.org/t.fits.fz"])


def test_cloudflare_purge_raises_on_non_dict_response():
    # A proxy/gateway error surfaced as non-dict JSON must become a clean DeployError,
    # not an AttributeError on .get.
    purger = CloudflarePurge("z", "t", post=lambda u, d, h: ["gateway error"])
    with pytest.raises(DeployError, match="purge failed"):
        purger.purge(["https://d.org/t.fits.fz"])


def test_cloudflare_purge_noop_on_empty():
    calls = []
    CloudflarePurge("z", "t", post=lambda u, d, h: calls.append(1) or {"success": True}).purge([])
    assert calls == []


# ----------------------------------------------------------- adapter factories


def test_cloudflare_from_config(monkeypatch):
    monkeypatch.setenv("CLOUDFLARE_API_TOKEN", "tok")
    assert CloudflarePurge.from_config(cfg(zone_id="z1")) is not None
    monkeypatch.delenv("CLOUDFLARE_API_TOKEN", raising=False)
    assert CloudflarePurge.from_config(cfg(zone_id="z1")) is None  # token missing → disabled
    monkeypatch.setenv("CLOUDFLARE_API_TOKEN", "tok")
    assert CloudflarePurge.from_config(cfg(zone_id=None)) is None  # no zone → disabled


def test_r2_from_config_requires_credentials(monkeypatch):
    monkeypatch.delenv("R2_ACCESS_KEY_ID", raising=False)
    monkeypatch.delenv("R2_SECRET_ACCESS_KEY", raising=False)
    with pytest.raises(DeployError, match="R2_ACCESS_KEY_ID"):
        R2Target.from_config(cfg())  # raises before importing boto3


# ------------------------------------------------------------------ confirm


def test_confirm_false_aborts_without_writes(tmp_path):
    root = make_dataset(tmp_path)
    t = FakeTarget()
    result = deploy_dataset(root, cfg(), t, run_verify=False, confirm=lambda diff: False)
    assert result.aborted and result.uploaded == []
    assert not any(op in ("put_file", "put_bytes", "delete", "cors") for op, _ in t.ops)


def test_confirm_receives_diff_and_proceeds(tmp_path):
    root = make_dataset(tmp_path)
    t = FakeTarget()
    captured = []

    def confirm(diff):
        captured.append(len(diff.upload))
        return True

    result = deploy_dataset(root, cfg(), t, run_verify=False, confirm=confirm)
    assert not result.aborted and result.uploaded
    assert captured == [len(result.uploaded)]  # confirm saw the real plan


# ----------------------------------------------------------------- site-only


def test_site_only_uploads_only_viewer_files(tmp_path):
    root = make_dataset(tmp_path)
    t = FakeTarget()
    deploy_dataset(root, cfg(), t, run_verify=False)  # full deploy first
    # Change a viewer file AND a tile; --site-only must push only the viewer file.
    (root / "index.html").write_text("<!doctype html><title>v2</title><script src=./assets/index-abc.js></script>")
    (root / "f444w" / "img_z0.fits.fz").write_bytes(b"changed tile, NOT for site-only")
    t.ops.clear()
    purger = FakePurger()
    result = deploy_dataset(root, cfg(), t, purger=purger, site_only=True, run_verify=False)
    assert result.uploaded == ["index.html"]  # only the viewer file
    assert result.purged == [] and purger.batches == []  # site files aren't purged
    assert not any(op == "cors" for op, _ in t.ops)  # CORS not re-set on a viewer refresh
    assert t.objects["f444w/img_z0.fits.fz"] == b"tile-bytes-0"  # tile untouched in the bucket


def test_site_only_preserves_data_entries_in_the_ledger(tmp_path):
    root = make_dataset(tmp_path)
    t = FakeTarget()
    deploy_dataset(root, cfg(), t, run_verify=False)
    before = DeployManifest.from_dict(json.loads(t.objects[DEPLOY_MANIFEST_NAME]))
    tiles_before = {f.path for f in before.files if f.path.endswith(".fits.fz")}
    assert tiles_before  # sanity: the full ledger had tile entries

    (root / "index.html").write_text("<!doctype html><title>v2</title>")
    deploy_dataset(root, cfg(), t, site_only=True, run_verify=False)
    after = DeployManifest.from_dict(json.loads(t.objects[DEPLOY_MANIFEST_NAME]))

    # The data entries are preserved (a partial viewer refresh must not orphan them)...
    assert {f.path for f in after.files if f.path.endswith(".fits.fz")} == tiles_before
    # ...and the index.html entry reflects the new content.
    idx_before = next(f for f in before.files if f.path == "index.html")
    idx_after = next(f for f in after.files if f.path == "index.html")
    assert idx_after.sha256 != idx_before.sha256


def test_site_only_with_no_prior_ledger_warns_and_uploads_site_only(tmp_path):
    # --site-only before any full deploy: warn, push only the viewer files, and write
    # a ledger of just those (merge with remote=None).
    root = make_dataset(tmp_path)
    t = FakeTarget()
    logs = []
    result = deploy_dataset(root, cfg(), t, site_only=True, run_verify=False, on_progress=logs.append)
    assert set(result.uploaded) == {"index.html", "assets/index-abc.js"}
    assert any("no prior deploy" in m for m in logs)
    led = DeployManifest.from_dict(json.loads(t.objects[DEPLOY_MANIFEST_NAME]))
    assert {f.path for f in led.files} == {"index.html", "assets/index-abc.js"}


# -------------------------------------------------------------- CLI wiring


def _project(tmp_path, *, with_deploy=True):
    """A fitsgl.toml + its band input + a built dataset dir at dist/cosmos-web/."""
    (tmp_path / "a.fits").write_text("")
    deploy_block = (
        '[deploy]\nbucket = "b"\nendpoint = "https://e"\npublic_url = "https://u/cosmos-web"\n'
        if with_deploy else ""
    )
    (tmp_path / "fitsgl.toml").write_text(
        '[dataset]\nname = "cosmos-web"\n[[dataset.bands]]\nname = "a"\ninput = "a.fits"\n' + deploy_block
    )
    out = tmp_path / "dist"
    out.mkdir()
    make_dataset(out)  # builds dist/cosmos-web/
    return tmp_path / "fitsgl.toml", out


def test_cli_deploy_without_deploy_block_errors(tmp_path, capsys):
    from fitsgl.cli import main

    toml, out = _project(tmp_path, with_deploy=False)
    assert main(["deploy", "-c", str(toml), "-o", str(out)]) == 2
    assert "no [deploy]" in capsys.readouterr().err


def test_cli_deploy_missing_credentials_errors(tmp_path, monkeypatch, capsys):
    from fitsgl.cli import main

    monkeypatch.delenv("R2_ACCESS_KEY_ID", raising=False)
    monkeypatch.delenv("R2_SECRET_ACCESS_KEY", raising=False)
    toml, out = _project(tmp_path)
    assert main(["deploy", "-c", str(toml), "-o", str(out)]) == 2
    assert "R2_ACCESS_KEY_ID" in capsys.readouterr().err


def test_cli_deploy_full_run_with_stubbed_target(tmp_path, monkeypatch):
    import fitsgl.cli as cli

    toml, out = _project(tmp_path)
    ft = FakeTarget()
    monkeypatch.setattr(cli, "R2Target", type("R2", (), {"from_config": classmethod(lambda cls, c: ft)}))
    monkeypatch.setattr(cli, "CloudflarePurge", type("CF", (), {"from_config": classmethod(lambda cls, c: None)}))
    rc = cli.main(["deploy", "-c", str(toml), "-o", str(out), "--yes", "--no-verify"])
    assert rc == 0
    assert "fitsgl.json" in ft.objects and DEPLOY_MANIFEST_NAME in ft.objects  # uploaded + ledger written


def test_cli_deploy_dry_run_makes_no_writes(tmp_path, monkeypatch, capsys):
    import fitsgl.cli as cli

    toml, out = _project(tmp_path)
    ft = FakeTarget()
    monkeypatch.setattr(cli, "R2Target", type("R2", (), {"from_config": classmethod(lambda cls, c: ft)}))
    monkeypatch.setattr(cli, "CloudflarePurge", type("CF", (), {"from_config": classmethod(lambda cls, c: None)}))
    rc = cli.main(["deploy", "-c", str(toml), "-o", str(out), "--dry-run"])
    assert rc == 0
    assert "dry run" in capsys.readouterr().out
    assert not any(op in ("put_file", "put_bytes", "delete", "cors") for op, _ in ft.ops)


def test_cli_deploy_exits_1_on_verify_failure(tmp_path, monkeypatch):
    import fitsgl.cli as cli

    toml, out = _project(tmp_path)
    monkeypatch.setattr(cli, "R2Target", type("R2", (), {"from_config": classmethod(lambda cls, c: FakeTarget())}))
    monkeypatch.setattr(cli, "CloudflarePurge", type("CF", (), {"from_config": classmethod(lambda cls, c: None)}))
    bad = VerifyReport(base_url="https://u/cosmos-web")
    bad.add("Range → 206", FAIL, "host ignores Range")
    monkeypatch.setattr(
        cli, "deploy_dataset",
        lambda *a, **k: DeployResult(diff=DeployDiff(), dry_run=False, verify_report=bad),
    )
    assert cli.main(["deploy", "-c", str(toml), "-o", str(out), "--yes"]) == 1  # verify failure → exit 1


def test_confirm_deploy_prompt(monkeypatch):
    from fitsgl.cli import _confirm_deploy

    confirm = _confirm_deploy("my-bucket")
    assert confirm(DeployDiff()) is True  # no-op → auto-yes, no prompt

    f = DeployFile(path="x.fits.fz", cls=CLASS_TILE, content_type="application/octet-stream",
                   cache_control="cc", sha256="s", size=1)
    nonnoop = DeployDiff(upload=[f])
    monkeypatch.setattr("builtins.input", lambda _p: "y")
    assert confirm(nonnoop) is True
    monkeypatch.setattr("builtins.input", lambda _p: "n")
    assert confirm(nonnoop) is False
    monkeypatch.setattr("builtins.input", lambda _p: "")
    assert confirm(nonnoop) is False

    def _raise_eof(_p):
        raise EOFError

    monkeypatch.setattr("builtins.input", _raise_eof)
    assert confirm(nonnoop) is False  # non-interactive stdin → clean decline, not a crash


# ----------------------------------------------------------------- .env loading


def _capture_creds_target(seen):
    """A stub R2Target whose from_config records the creds it sees in the env."""

    def from_config(cls, c):
        seen["ak"] = os.environ.get("R2_ACCESS_KEY_ID")
        seen["sk"] = os.environ.get("R2_SECRET_ACCESS_KEY")
        return FakeTarget()

    return type("R2", (), {"from_config": classmethod(from_config)})


def test_cli_deploy_loads_dotenv_next_to_config(tmp_path, monkeypatch, capsys):
    import fitsgl.cli as cli

    # No creds in the shell — they must come from the .env next to the fitsgl.toml.
    monkeypatch.delenv("R2_ACCESS_KEY_ID", raising=False)
    monkeypatch.delenv("R2_SECRET_ACCESS_KEY", raising=False)
    toml, out = _project(tmp_path)
    (tmp_path / ".env").write_text("R2_ACCESS_KEY_ID=ak\nR2_SECRET_ACCESS_KEY=sk\n")

    seen: dict[str, str | None] = {}
    monkeypatch.setattr(cli, "R2Target", _capture_creds_target(seen))
    monkeypatch.setattr(cli, "CloudflarePurge", type("CF", (), {"from_config": classmethod(lambda cls, c: None)}))

    rc = cli.main(["deploy", "-c", str(toml), "-o", str(out), "--yes", "--no-verify"])
    assert rc == 0
    assert seen == {"ak": "ak", "sk": "sk"}  # adapters saw the .env-supplied creds
    assert "loaded R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY" in capsys.readouterr().out


def test_cli_deploy_shell_env_wins_over_dotenv(tmp_path, monkeypatch):
    import fitsgl.cli as cli

    monkeypatch.setenv("R2_ACCESS_KEY_ID", "from-shell")
    monkeypatch.delenv("R2_SECRET_ACCESS_KEY", raising=False)
    toml, out = _project(tmp_path)
    (tmp_path / ".env").write_text("R2_ACCESS_KEY_ID=from-file\nR2_SECRET_ACCESS_KEY=sk\n")

    seen: dict[str, str | None] = {}
    monkeypatch.setattr(cli, "R2Target", _capture_creds_target(seen))
    monkeypatch.setattr(cli, "CloudflarePurge", type("CF", (), {"from_config": classmethod(lambda cls, c: None)}))

    cli.main(["deploy", "-c", str(toml), "-o", str(out), "--yes", "--no-verify"])
    assert seen["ak"] == "from-shell"  # real env wins; the .env only filled the absent key
    assert seen["sk"] == "sk"


def test_cli_deploy_custom_env_file_flag(tmp_path, monkeypatch):
    import fitsgl.cli as cli

    monkeypatch.delenv("R2_ACCESS_KEY_ID", raising=False)
    monkeypatch.delenv("R2_SECRET_ACCESS_KEY", raising=False)
    toml, out = _project(tmp_path)
    custom = tmp_path / "secrets.env"
    custom.write_text("R2_ACCESS_KEY_ID=ak2\nR2_SECRET_ACCESS_KEY=sk2\n")

    seen: dict[str, str | None] = {}
    monkeypatch.setattr(cli, "R2Target", _capture_creds_target(seen))
    monkeypatch.setattr(cli, "CloudflarePurge", type("CF", (), {"from_config": classmethod(lambda cls, c: None)}))

    rc = cli.main(["deploy", "-c", str(toml), "-o", str(out), "--env-file", str(custom), "--yes", "--no-verify"])
    assert rc == 0 and seen == {"ak": "ak2", "sk": "sk2"}


def test_cli_deploy_missing_explicit_env_file_errors(tmp_path, capsys):
    from fitsgl.cli import main

    toml, out = _project(tmp_path)
    rc = main(["deploy", "-c", str(toml), "-o", str(out), "--env-file", str(tmp_path / "nope.env"), "--yes"])
    assert rc == 2
    assert "--env-file not found" in capsys.readouterr().err
