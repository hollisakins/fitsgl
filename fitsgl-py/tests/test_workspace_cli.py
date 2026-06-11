"""Tests for the workspace CLI orchestration (build/deploy/index with -w).

The heavy per-field work (build_dataset, deploy_dataset, emit_collection,
deploy_collection_root) is monkeypatched to recorders so these tests target the
ORCHESTRATION: selection, the CORS-once + target-once rules, per-field DeployConfig
derivation, continue-and-summarize, and the full-vs-subset collection refresh.
"""

import textwrap
from dataclasses import dataclass

import pytest

from fitsgl import build as build_mod
from fitsgl import cli
from fitsgl import deploy as deploy_mod
from fitsgl.deploy import DeployResult
from fitsgl.deploy_plan import DeployDiff


def write(p, body):
    p.write_text(textwrap.dedent(body))
    return p


def child(tmp_path, name, *, dataset_name=None):
    d = tmp_path / name
    d.mkdir()
    write(
        d / "fitsgl.toml",
        f'[dataset]\nname = "{dataset_name or name}"\n[[dataset.bands]]\nname = "b"\ninput = "b.fits"\n',
    )
    return d / "fitsgl.toml"


def workspace(tmp_path, body):
    return write(tmp_path / "fitsgl.workspace.toml", body)


@dataclass
class FakeChild:
    name: str
    deploy: object = None


class FakeTarget:
    def __init__(self):
        self.cors_calls = 0

    def put_cors(self, origins, methods, headers):
        self.cors_calls += 1


# ----------------------------------------------------------------- dispatch


def test_build_c_and_w_mutually_exclusive(capsys):
    with pytest.raises(SystemExit) as e:
        cli.main(["build", "-c", "a.toml", "-w", "b.toml"])
    assert e.value.code == 2
    assert "not allowed with" in capsys.readouterr().err


def test_bare_build_uses_single_path(tmp_path, monkeypatch):
    called = {}
    monkeypatch.setattr(cli, "_cmd_build", lambda args: called.setdefault("single", True) or 0)
    monkeypatch.setattr(cli, "_cmd_build_workspace", lambda args: called.setdefault("ws", True) or 0)
    cli.main(["build", "-c", str(tmp_path / "x.toml")])
    assert called == {"single": True}


def test_build_w_routes_to_workspace(tmp_path, monkeypatch):
    called = {}
    monkeypatch.setattr(cli, "_cmd_build_workspace", lambda args: called.setdefault("ws", True) or 0)
    cli.main(["build", "-w", str(tmp_path / "ws.toml")])
    assert called == {"ws": True}


# ----------------------------------------------------------------- build loop


def _stub_build(monkeypatch):
    """Monkeypatch load_config + build_dataset; return the call recorder."""
    calls = {"build": [], "site": []}
    monkeypatch.setattr(cli, "load_config", lambda p: FakeChild(name=p.parent.name))
    monkeypatch.setattr(build_mod, "build_dataset", lambda child, out, **kw: calls["build"].append((child.name, kw)))
    monkeypatch.setattr(build_mod, "write_site", lambda child, out, **kw: calls["site"].append(child.name))
    return calls


def test_build_loops_all_fields(tmp_path, monkeypatch):
    child(tmp_path, "cosmos")
    child(tmp_path, "egs")
    workspace(tmp_path, '[workspace]\nname="s"\n[[field]]\nconfig="cosmos/fitsgl.toml"\n[[field]]\nconfig="egs/fitsgl.toml"\n')
    calls = _stub_build(monkeypatch)
    rc = cli.main(["build", "-w", str(tmp_path / "fitsgl.workspace.toml"), "-o", str(tmp_path / "dist")])
    assert rc == 0
    assert [n for n, _ in calls["build"]] == ["cosmos", "egs"]


def test_build_subset_only_selected(tmp_path, monkeypatch):
    child(tmp_path, "cosmos")
    child(tmp_path, "egs")
    workspace(tmp_path, '[workspace]\nname="s"\n[[field]]\nconfig="cosmos/fitsgl.toml"\n[[field]]\nconfig="egs/fitsgl.toml"\n')
    calls = _stub_build(monkeypatch)
    rc = cli.main(["build", "-w", str(tmp_path / "fitsgl.workspace.toml"), "--field", "egs"])
    assert rc == 0
    assert [n for n, _ in calls["build"]] == ["egs"]


def test_build_unknown_field_errors(tmp_path, monkeypatch, capsys):
    child(tmp_path, "cosmos")
    workspace(tmp_path, '[workspace]\nname="s"\n[[field]]\nconfig="cosmos/fitsgl.toml"\n')
    _stub_build(monkeypatch)
    rc = cli.main(["build", "-w", str(tmp_path / "fitsgl.workspace.toml"), "--field", "nope"])
    assert rc == 2
    assert "unknown --field" in capsys.readouterr().err


def test_build_continue_on_failure(tmp_path, monkeypatch):
    child(tmp_path, "cosmos")
    child(tmp_path, "egs")
    workspace(tmp_path, '[workspace]\nname="s"\n[[field]]\nconfig="cosmos/fitsgl.toml"\n[[field]]\nconfig="egs/fitsgl.toml"\n')
    monkeypatch.setattr(cli, "load_config", lambda p: FakeChild(name=p.parent.name))
    built = []

    def flaky(child, out, **kw):
        if child.name == "cosmos":
            raise ValueError("bad mosaic")
        built.append(child.name)

    monkeypatch.setattr(build_mod, "build_dataset", flaky)
    rc = cli.main(["build", "-w", str(tmp_path / "fitsgl.workspace.toml")])
    assert rc == 1  # a field failed
    assert built == ["egs"]  # but the other still built


def test_build_passthrough_flags(tmp_path, monkeypatch):
    child(tmp_path, "cosmos")
    workspace(tmp_path, '[workspace]\nname="s"\n[[field]]\nconfig="cosmos/fitsgl.toml"\n')
    calls = _stub_build(monkeypatch)
    cli.main(["build", "-w", str(tmp_path / "fitsgl.workspace.toml"), "--overwrite", "--no-verify", "--no-site"])
    _, kw = calls["build"][0]
    assert kw["overwrite"] is True and kw["verify"] is False and kw["with_site"] is False


def test_build_site_only_calls_write_site(tmp_path, monkeypatch):
    child(tmp_path, "cosmos")
    workspace(tmp_path, '[workspace]\nname="s"\n[[field]]\nconfig="cosmos/fitsgl.toml"\n')
    calls = _stub_build(monkeypatch)
    cli.main(["build", "-w", str(tmp_path / "fitsgl.workspace.toml"), "--site-only"])
    assert calls["site"] == ["cosmos"] and calls["build"] == []


def test_build_validates_duplicate_names(tmp_path, monkeypatch):
    child(tmp_path, "a", dataset_name="dup")
    child(tmp_path, "b", dataset_name="dup")
    workspace(tmp_path, '[workspace]\nname="s"\n[[field]]\nconfig="a/fitsgl.toml"\n[[field]]\nconfig="b/fitsgl.toml"\n')
    _stub_build(monkeypatch)
    rc = cli.main(["build", "-w", str(tmp_path / "fitsgl.workspace.toml")])
    assert rc == 2  # validation fails before building


# ----------------------------------------------------------------- index


def test_index_emits_collection(tmp_path, monkeypatch):
    child(tmp_path, "cosmos")
    child(tmp_path, "egs")
    workspace(
        tmp_path,
        '[workspace]\nname="survey"\ntitle="The Survey"\n'
        '[[field]]\nconfig="cosmos/fitsgl.toml"\n[[field]]\nconfig="egs/fitsgl.toml"\n',
    )
    recorded = {}

    def fake_emit(out_root, *, name, title, field_specs, on_progress=None):
        recorded["name"] = name
        recorded["title"] = title
        recorded["prefixes"] = [p for p, _, _ in field_specs]
        from fitsgl.collection import EmitResult

        return EmitResult(staging_dir=out_root / ".collection", fields=[{} for _ in field_specs])

    monkeypatch.setattr(cli, "emit_collection", fake_emit)
    rc = cli.main(["index", "-w", str(tmp_path / "fitsgl.workspace.toml"), "-o", str(tmp_path / "dist")])
    assert rc == 0
    assert recorded["name"] == "survey"
    assert recorded["title"] == "The Survey"
    assert recorded["prefixes"] == ["cosmos", "egs"]


# ----------------------------------------------------------------- deploy loop


def _stub_deploy(monkeypatch, target, *, fail_prefix=None, verify_fail_prefix=None):
    """Patch the deploy adapters + per-field/root deploy to recorders.

    ``fail_prefix`` makes that field's deploy raise DeployError; ``verify_fail_prefix``
    makes it return a DeployResult whose verify_report fails. ``emit_specs`` captures
    which field prefixes the collection refresh was built from.
    """
    from fitsgl.deploy import DeployError
    from fitsgl.verify import FAIL, VerifyReport

    calls = {"deploy": [], "emit": 0, "root": 0, "target_built": 0, "emit_specs": None}

    def fake_target_factory(cls, config, *, concurrency=8):
        calls["target_built"] += 1
        return target

    monkeypatch.setattr(deploy_mod.R2Target, "from_config", classmethod(fake_target_factory))
    monkeypatch.setattr(deploy_mod.CloudflarePurge, "from_config", classmethod(lambda cls, c: None))
    monkeypatch.setattr(cli, "load_env_file", lambda p: [])

    fail_set = set(fail_prefix or ())
    verify_fail_set = set(verify_fail_prefix or ())

    def fake_deploy(dataset_dir, config, tgt, **kw):
        calls["deploy"].append((config.prefix, config.public_url, kw.get("set_cors")))
        if config.prefix in fail_set:
            raise DeployError(f"boom {config.prefix}")
        report = None
        if config.prefix in verify_fail_set:  # a real VerifyReport so format_report works
            report = VerifyReport(base_url=config.public_url)
            report.add("Range → 206", FAIL, "host ignored Range")
        return DeployResult(diff=DeployDiff(), dry_run=kw.get("dry_run", False), verify_report=report)

    def fake_emit(out_root, *, name, title, field_specs, on_progress=None):
        calls["emit"] += 1
        calls["emit_specs"] = [p for p, _, _ in field_specs]

    monkeypatch.setattr(deploy_mod, "deploy_dataset", fake_deploy)
    monkeypatch.setattr(cli, "emit_collection", fake_emit)
    monkeypatch.setattr(deploy_mod, "deploy_collection_root", lambda *a, **k: calls.__setitem__("root", calls["root"] + 1))
    return calls


def _deploy_workspace(tmp_path):
    child(tmp_path, "cosmos")
    child(tmp_path, "egs")
    workspace(
        tmp_path,
        '[workspace]\nname="s"\n[deploy]\nbucket="data"\nendpoint="https://e"\n'
        'base_url="https://data.example.org"\nviewer_origin="https://embed"\n'
        '[[field]]\nconfig="cosmos/fitsgl.toml"\n[[field]]\nconfig="egs/fitsgl.toml"\n',
    )
    out = tmp_path / "dist"
    for f in ("cosmos", "egs"):
        (out / f).mkdir(parents=True)
        (out / f / "fitsgl.json").write_text('{"schemaVersion": 1, "dataset": {"name": "%s"}}' % f)
    return tmp_path / "fitsgl.workspace.toml", out


def test_deploy_full_sets_cors_once_and_target_once(tmp_path, monkeypatch):
    ws, out = _deploy_workspace(tmp_path)
    target = FakeTarget()
    calls = _stub_deploy(monkeypatch, target)
    rc = cli.main(["deploy", "-w", str(ws), "-o", str(out), "--yes"])
    assert rc == 0
    assert target.cors_calls == 1  # CORS once for the shared bucket
    assert calls["target_built"] == 1  # one R2 target reused across fields
    # every per-field deploy ran with set_cors=False and the derived public_url
    assert calls["deploy"] == [
        ("cosmos", "https://data.example.org/cosmos", False),
        ("egs", "https://data.example.org/egs", False),
    ]
    # full deploy refreshes + deploys the collection root from all succeeded fields
    assert calls["emit"] == 1 and calls["root"] == 1
    assert calls["emit_specs"] == ["cosmos", "egs"]


def test_deploy_subset_skips_collection_root(tmp_path, monkeypatch):
    ws, out = _deploy_workspace(tmp_path)
    calls = _stub_deploy(monkeypatch, FakeTarget())
    rc = cli.main(["deploy", "-w", str(ws), "-o", str(out), "--yes", "--field", "cosmos"])
    assert rc == 0
    assert [p for p, _, _ in calls["deploy"]] == ["cosmos"]
    assert calls["emit"] == 0 and calls["root"] == 0  # subset must not touch the root


def test_deploy_dry_run_no_cors_no_root(tmp_path, monkeypatch):
    ws, out = _deploy_workspace(tmp_path)
    target = FakeTarget()
    calls = _stub_deploy(monkeypatch, target)
    rc = cli.main(["deploy", "-w", str(ws), "-o", str(out), "--dry-run"])
    assert rc == 0
    assert target.cors_calls == 0  # no CORS on dry-run
    assert calls["root"] == 0 and calls["emit"] == 0


def test_deploy_site_only_skips_cors(tmp_path, monkeypatch):
    ws, out = _deploy_workspace(tmp_path)
    target = FakeTarget()
    calls = _stub_deploy(monkeypatch, target)
    rc = cli.main(["deploy", "-w", str(ws), "-o", str(out), "--yes", "--site-only"])
    assert rc == 0
    assert target.cors_calls == 0
    assert all(set_cors is False for _, _, set_cors in calls["deploy"])


def test_deploy_preflight_unbuilt_field_errors(tmp_path, monkeypatch, capsys):
    ws, out = _deploy_workspace(tmp_path)
    (out / "egs" / "fitsgl.json").unlink()  # egs not built
    calls = _stub_deploy(monkeypatch, FakeTarget())
    rc = cli.main(["deploy", "-w", str(ws), "-o", str(out), "--yes"])
    assert rc == 2
    assert "not built" in capsys.readouterr().err
    assert calls["target_built"] == 0  # failed before constructing the target/network


def test_deploy_no_deploy_block_errors(tmp_path, monkeypatch, capsys):
    child(tmp_path, "cosmos")
    workspace(tmp_path, '[workspace]\nname="s"\n[[field]]\nconfig="cosmos/fitsgl.toml"\n')
    out = tmp_path / "dist"
    (out / "cosmos").mkdir(parents=True)
    (out / "cosmos" / "fitsgl.json").write_text("{}")
    rc = cli.main(["deploy", "-w", str(tmp_path / "fitsgl.workspace.toml"), "-o", str(out), "--yes"])
    assert rc == 2
    assert "no [deploy] table" in capsys.readouterr().err


# ------------------------------------------ collection refresh guards (P1/P2)


def test_deploy_all_fields_fail_leaves_collection_untouched(tmp_path, monkeypatch):
    ws, out = _deploy_workspace(tmp_path)
    calls = _stub_deploy(monkeypatch, FakeTarget(), fail_prefix={"cosmos", "egs"})
    rc = cli.main(["deploy", "-w", str(ws), "-o", str(out), "--yes"])
    assert rc == 1
    # the live (populated) collection.json must NOT be overwritten with an empty one
    assert calls["emit"] == 0 and calls["root"] == 0


def test_deploy_partial_failure_leaves_collection_untouched(tmp_path, monkeypatch):
    ws, out = _deploy_workspace(tmp_path)
    calls = _stub_deploy(monkeypatch, FakeTarget(), fail_prefix={"egs"})
    rc = cli.main(["deploy", "-w", str(ws), "-o", str(out), "--yes"])
    assert rc == 1
    # cosmos deployed, but a partial failure must not drop a (still-live) field from
    # the picker, so the root is left as-is until a fully clean deploy.
    assert calls["emit"] == 0 and calls["root"] == 0


def test_deploy_verify_failure_still_publishes_collection_but_exits_1(tmp_path, monkeypatch):
    # A verify failure means the bytes uploaded but the LIVE check failed (a CDN/setup
    # issue) — the field still belongs in the collection, which must still publish; the
    # command exits 1 to flag the problem.
    ws, out = _deploy_workspace(tmp_path)
    calls = _stub_deploy(monkeypatch, FakeTarget(), verify_fail_prefix={"egs"})
    rc = cli.main(["deploy", "-w", str(ws), "-o", str(out), "--yes"])
    assert rc == 1  # verify failure flags the command
    assert calls["emit"] == 1 and calls["root"] == 1  # but all fields uploaded → root published
    assert calls["emit_specs"] == ["cosmos", "egs"]  # incl. the verify-failed (but uploaded) field


def test_deploy_dry_run_summary_says_would_deploy(tmp_path, monkeypatch, capsys):
    ws, out = _deploy_workspace(tmp_path)
    _stub_deploy(monkeypatch, FakeTarget())
    rc = cli.main(["deploy", "-w", str(ws), "-o", str(out), "--dry-run"])
    assert rc == 0
    out_text = capsys.readouterr().out
    assert "would deploy" in out_text and "field(s) deployed" not in out_text


# ------------------------------------------------- --field requires -w


def test_build_field_without_workspace_rejected(tmp_path, capsys):
    rc = cli.main(["build", "-c", str(tmp_path / "x.toml"), "--field", "cosmos"])
    assert rc == 2
    assert "--field requires -w/--workspace" in capsys.readouterr().err


def test_deploy_field_without_workspace_rejected(tmp_path, capsys):
    rc = cli.main(["deploy", "-c", str(tmp_path / "x.toml"), "--field", "cosmos"])
    assert rc == 2
    assert "--field requires -w/--workspace" in capsys.readouterr().err


# ----------------------------------------- subset build is lazy (no input stat)


def test_build_subset_does_not_stat_unselected_inputs(tmp_path, monkeypatch):
    # cosmos's band input is NEVER created; only egs's exists. A lazy subset build
    # must peek [dataset].name (no input stat) for cosmos and full-load only egs.
    child(tmp_path, "cosmos")  # cosmos/b.fits absent
    child(tmp_path, "egs")
    (tmp_path / "egs" / "b.fits").write_text("")  # only the selected field's input exists
    workspace(
        tmp_path,
        '[workspace]\nname="s"\n[[field]]\nconfig="cosmos/fitsgl.toml"\n[[field]]\nconfig="egs/fitsgl.toml"\n',
    )
    built = []
    # load_config is NOT stubbed: the real input-statting loader runs for selected fields.
    monkeypatch.setattr(build_mod, "build_dataset", lambda child, out, **kw: built.append(child.name))
    rc = cli.main(["build", "-w", str(tmp_path / "fitsgl.workspace.toml"), "--field", "egs", "-o", str(tmp_path / "dist")])
    assert rc == 0  # cosmos's missing input was never stat'd → validation/load stayed lazy
    assert built == ["egs"]
