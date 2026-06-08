"""Tests for the workspace parser + per-field derivation (workspace.py).

Pure config logic: no FITS, no network. Child tomls are minimal — the workspace
loader is lazy (it never calls load_config), so a child's band inputs need not
exist for the workspace itself to parse + validate.
"""

import textwrap

import pytest

from fitsgl.config import read_dataset_name
from fitsgl.deploy import object_key
from fitsgl.deploy_plan import DEFAULT_SWR_GRACE, DEFAULT_TILE_MAX_AGE, DEFAULT_UPLOAD_CONCURRENCY
from fitsgl.workspace import (
    field_deploy_config,
    field_prefix,
    field_public_url,
    field_title,
    load_workspace,
    select_fields,
    validate_workspace_fields,
)


def write(path, body: str):
    path.write_text(textwrap.dedent(body))
    return path


def child_toml(tmp_path, name: str, *, dataset_name: str | None = None, with_deploy=False):
    """A minimal child fitsgl.toml in its own subdir; its band input need NOT exist."""
    d = tmp_path / name
    d.mkdir()
    deploy = (
        '[deploy]\nbucket = "x"\nendpoint = "https://x"\npublic_url = "https://x/y"\n' if with_deploy else ""
    )
    write(
        d / "fitsgl.toml",
        f"""
        [dataset]
        name = "{dataset_name or name}"
        [[dataset.bands]]
        name = "b"
        input = "b.fits"
        {deploy}
        """,
    )
    return d / "fitsgl.toml"


def ws_toml(tmp_path, body: str):
    return write(tmp_path / "fitsgl.workspace.toml", body)


def names_for(ws):
    return [read_dataset_name(f.config_path) for f in ws.fields]


# ----------------------------------------------------------------- happy path


def test_parses_minimal_workspace(tmp_path):
    child_toml(tmp_path, "cosmos")
    child_toml(tmp_path, "egs")
    p = ws_toml(
        tmp_path,
        """
        [workspace]
        name = "survey"
        [[field]]
        config = "cosmos/fitsgl.toml"
        [[field]]
        config = "egs/fitsgl.toml"
        """,
    )
    ws = load_workspace(p)
    assert ws.name == "survey"
    assert ws.deploy is None
    assert ws.collection is None
    assert len(ws.fields) == 2
    assert ws.fields[0].config_path == (tmp_path / "cosmos" / "fitsgl.toml").resolve()


def test_parses_workspace_with_deploy_and_collection(tmp_path):
    child_toml(tmp_path, "cosmos")
    p = ws_toml(
        tmp_path,
        """
        [workspace]
        name = "survey"
        title = "The Survey"
        [collection]
        name = "coll"
        title = "Coll Title"
        [deploy]
        bucket = "data"
        endpoint = "https://acct.r2.cloudflarestorage.com"
        base_url = "https://data.example.org"
        zone_id = "zone1"
        viewer_origin = "https://embed.example"
        tile_max_age = 999
        concurrency = 4
        [[field]]
        config = "cosmos/fitsgl.toml"
        """,
    )
    ws = load_workspace(p)
    assert ws.title == "The Survey"
    assert ws.collection.name == "coll"
    assert ws.collection.title == "Coll Title"
    d = ws.deploy
    assert (d.bucket, d.endpoint, d.base_url) == ("data", "https://acct.r2.cloudflarestorage.com", "https://data.example.org")
    assert d.zone_id == "zone1"
    assert d.viewer_origin == "https://embed.example"
    assert d.tile_max_age == 999
    assert d.concurrency == 4
    assert d.swr_grace == DEFAULT_SWR_GRACE  # not a TOML knob
    assert d.target == "r2"


def test_deploy_defaults(tmp_path):
    child_toml(tmp_path, "cosmos")
    p = ws_toml(
        tmp_path,
        """
        [workspace]
        name = "s"
        [deploy]
        bucket = "data"
        endpoint = "https://e"
        base_url = "https://b"
        [[field]]
        config = "cosmos/fitsgl.toml"
        """,
    )
    d = load_workspace(p).deploy
    assert d.zone_id is None
    assert d.viewer_origin == "*"
    assert d.tile_max_age == DEFAULT_TILE_MAX_AGE
    assert d.concurrency == DEFAULT_UPLOAD_CONCURRENCY


def test_collection_name_defaults_to_workspace_name(tmp_path):
    child_toml(tmp_path, "cosmos")
    p = ws_toml(
        tmp_path,
        """
        [workspace]
        name = "survey"
        [collection]
        [[field]]
        config = "cosmos/fitsgl.toml"
        """,
    )
    ws = load_workspace(p)
    assert ws.collection.name == "survey"
    assert ws.collection.title is None


def test_field_overrides_parsed(tmp_path):
    child_toml(tmp_path, "cosmos")
    p = ws_toml(
        tmp_path,
        """
        [workspace]
        name = "s"
        [[field]]
        config = "cosmos/fitsgl.toml"
        prefix = "cosmos-dr1"
        title = "COSMOS DR1"
        """,
    )
    f = load_workspace(p).fields[0]
    assert f.prefix == "cosmos-dr1"
    assert f.title == "COSMOS DR1"


# ------------------------------------------------------------ decision A: derivation


def test_field_prefix_defaults_to_child_name(tmp_path):
    child_toml(tmp_path, "cosmos")
    ws = load_workspace(
        ws_toml(tmp_path, '[workspace]\nname="s"\n[[field]]\nconfig="cosmos/fitsgl.toml"\n')
    )
    assert field_prefix(ws.fields[0], "cosmos") == "cosmos"


def test_field_prefix_override_wins(tmp_path):
    child_toml(tmp_path, "cosmos")
    ws = load_workspace(
        ws_toml(tmp_path, '[workspace]\nname="s"\n[[field]]\nconfig="cosmos/fitsgl.toml"\nprefix="c2"\n')
    )
    assert field_prefix(ws.fields[0], "cosmos") == "c2"


def test_field_public_url_is_base_plus_prefix(tmp_path):
    child_toml(tmp_path, "cosmos")
    ws = load_workspace(
        ws_toml(
            tmp_path,
            '[workspace]\nname="s"\n[deploy]\nbucket="b"\nendpoint="https://e"\n'
            'base_url="https://d.org/"\n[[field]]\nconfig="cosmos/fitsgl.toml"\n',
        )
    )
    # trailing slash on base_url collapses to a single separator
    assert field_public_url(ws.deploy, "cosmos") == "https://d.org/cosmos"


def test_field_deploy_config_projection_and_ledger_isolation(tmp_path):
    child_toml(tmp_path, "cosmos")
    child_toml(tmp_path, "egs")
    ws = load_workspace(
        ws_toml(
            tmp_path,
            '[workspace]\nname="s"\n[deploy]\nbucket="data"\nendpoint="https://e"\n'
            'base_url="https://d.org"\nzone_id="z"\nviewer_origin="https://x"\n'
            '[[field]]\nconfig="cosmos/fitsgl.toml"\n[[field]]\nconfig="egs/fitsgl.toml"\n',
        )
    )
    dc = field_deploy_config(ws, ws.fields[0], "cosmos")
    assert dc.bucket == "data"
    assert dc.prefix == "cosmos"
    assert dc.public_url == "https://d.org/cosmos"
    assert dc.zone_id == "z"
    assert dc.viewer_origin == "https://x"
    assert dc.target == "r2"
    # each field's ledger key is distinct -> independent incremental ledgers
    k0 = object_key(field_deploy_config(ws, ws.fields[0], "cosmos").prefix, "deploy-manifest.json")
    k1 = object_key(field_deploy_config(ws, ws.fields[1], "egs").prefix, "deploy-manifest.json")
    assert k0 != k1


def test_field_deploy_config_requires_deploy_block(tmp_path):
    child_toml(tmp_path, "cosmos")
    ws = load_workspace(ws_toml(tmp_path, '[workspace]\nname="s"\n[[field]]\nconfig="cosmos/fitsgl.toml"\n'))
    with pytest.raises(ValueError, match="deploy.* is required"):
        field_deploy_config(ws, ws.fields[0], "cosmos")


def test_field_title_fallback_chain(tmp_path):
    from fitsgl.workspace import FieldRef

    override = FieldRef(config_path=tmp_path / "x", prefix=None, title="Override")
    plain = FieldRef(config_path=tmp_path / "x", prefix=None, title=None)
    assert field_title(override, "cosmos", "Child Title") == "Override"
    assert field_title(plain, "cosmos", "Child Title") == "Child Title"  # child title
    assert field_title(plain, "cosmos", None) == "cosmos"  # child name


# ------------------------------------------------------------------ validation


def test_missing_workspace_table_raises(tmp_path):
    p = ws_toml(tmp_path, '[nope]\nx=1\n')
    with pytest.raises(ValueError, match="fitsgl.workspace.toml: missing or invalid .workspace."):
        load_workspace(p)


def test_no_fields_raises(tmp_path):
    p = ws_toml(tmp_path, '[workspace]\nname="s"\n')
    with pytest.raises(ValueError, match="at least one ..field.."):
        load_workspace(p)


def test_field_config_not_found_raises(tmp_path):
    p = ws_toml(tmp_path, '[workspace]\nname="s"\n[[field]]\nconfig="missing/fitsgl.toml"\n')
    with pytest.raises(FileNotFoundError, match="config not found"):
        load_workspace(p)


def test_duplicate_child_config_path_raises(tmp_path):
    child_toml(tmp_path, "cosmos")
    p = ws_toml(
        tmp_path,
        '[workspace]\nname="s"\n[[field]]\nconfig="cosmos/fitsgl.toml"\n'
        '[[field]]\nconfig="cosmos/fitsgl.toml"\n',
    )
    with pytest.raises(ValueError, match="referenced more than once"):
        load_workspace(p)


def test_deploy_target_must_be_r2(tmp_path):
    child_toml(tmp_path, "cosmos")
    p = ws_toml(
        tmp_path,
        '[workspace]\nname="s"\n[deploy]\ntarget="s3"\nbucket="b"\nendpoint="e"\nbase_url="u"\n'
        '[[field]]\nconfig="cosmos/fitsgl.toml"\n',
    )
    with pytest.raises(ValueError, match='target must be "r2"'):
        load_workspace(p)


def test_deploy_rejects_public_url(tmp_path):
    child_toml(tmp_path, "cosmos")
    p = ws_toml(
        tmp_path,
        '[workspace]\nname="s"\n[deploy]\nbucket="b"\nendpoint="e"\nbase_url="u"\n'
        'public_url="https://x"\n[[field]]\nconfig="cosmos/fitsgl.toml"\n',
    )
    with pytest.raises(ValueError, match="uses base_url, not public_url"):
        load_workspace(p)


def test_deploy_rejects_prefix(tmp_path):
    child_toml(tmp_path, "cosmos")
    p = ws_toml(
        tmp_path,
        '[workspace]\nname="s"\n[deploy]\nbucket="b"\nendpoint="e"\nbase_url="u"\n'
        'prefix="cosmos"\n[[field]]\nconfig="cosmos/fitsgl.toml"\n',
    )
    with pytest.raises(ValueError, match="per-field"):
        load_workspace(p)


def test_deploy_requires_base_url(tmp_path):
    child_toml(tmp_path, "cosmos")
    p = ws_toml(
        tmp_path,
        '[workspace]\nname="s"\n[deploy]\nbucket="b"\nendpoint="e"\n'
        '[[field]]\nconfig="cosmos/fitsgl.toml"\n',
    )
    with pytest.raises(ValueError, match="base_url"):
        load_workspace(p)


def test_base_url_not_required_without_deploy(tmp_path):
    child_toml(tmp_path, "cosmos")
    p = ws_toml(tmp_path, '[workspace]\nname="s"\n[[field]]\nconfig="cosmos/fitsgl.toml"\n')
    assert load_workspace(p).deploy is None  # build-only workspace parses fine


# ------------------------------------------ cross-field validation (via peeks)


def test_duplicate_dataset_name_raises(tmp_path):
    child_toml(tmp_path, "a", dataset_name="cosmos")
    child_toml(tmp_path, "b", dataset_name="cosmos")
    ws = load_workspace(
        ws_toml(
            tmp_path,
            '[workspace]\nname="s"\n[[field]]\nconfig="a/fitsgl.toml"\n[[field]]\nconfig="b/fitsgl.toml"\n',
        )
    )
    with pytest.raises(ValueError, match="both have dataset.name"):
        validate_workspace_fields(ws, names_for(ws))


def test_duplicate_effective_prefix_raises(tmp_path):
    child_toml(tmp_path, "a", dataset_name="alpha")
    child_toml(tmp_path, "b", dataset_name="beta")
    ws = load_workspace(
        ws_toml(
            tmp_path,
            '[workspace]\nname="s"\n[[field]]\nconfig="a/fitsgl.toml"\nprefix="dup"\n'
            '[[field]]\nconfig="b/fitsgl.toml"\nprefix="dup"\n',
        )
    )
    with pytest.raises(ValueError, match="same prefix"):
        validate_workspace_fields(ws, names_for(ws))


def test_reserved_prefix_raises(tmp_path):
    child_toml(tmp_path, "a", dataset_name="alpha")
    ws = load_workspace(
        ws_toml(tmp_path, '[workspace]\nname="s"\n[[field]]\nconfig="a/fitsgl.toml"\nprefix="assets"\n')
    )
    with pytest.raises(ValueError, match="reserved"):
        validate_workspace_fields(ws, names_for(ws))


def test_non_slug_prefix_raises(tmp_path):
    # dataset.name with a space -> the default prefix is not a clean URL segment
    child_toml(tmp_path, "a", dataset_name="My Field")
    ws = load_workspace(ws_toml(tmp_path, '[workspace]\nname="s"\n[[field]]\nconfig="a/fitsgl.toml"\n'))
    with pytest.raises(ValueError, match="not a clean URL/key segment"):
        validate_workspace_fields(ws, names_for(ws))


def test_valid_workspace_passes_validation(tmp_path):
    child_toml(tmp_path, "cosmos")
    child_toml(tmp_path, "egs")
    ws = load_workspace(
        ws_toml(
            tmp_path,
            '[workspace]\nname="s"\n[[field]]\nconfig="cosmos/fitsgl.toml"\n[[field]]\nconfig="egs/fitsgl.toml"\n',
        )
    )
    validate_workspace_fields(ws, names_for(ws))  # no raise


# ------------------------------------------------------------- lazy + selection


def test_load_workspace_does_not_stat_field_inputs(tmp_path):
    # child references a band input that does NOT exist; load_workspace still succeeds
    # (proves laziness), and read_dataset_name still works (cheap peek, no input stat).
    child_toml(tmp_path, "cosmos")  # b.fits is never created
    ws = load_workspace(ws_toml(tmp_path, '[workspace]\nname="s"\n[[field]]\nconfig="cosmos/fitsgl.toml"\n'))
    assert read_dataset_name(ws.fields[0].config_path) == "cosmos"


def test_select_fields_all(tmp_path):
    child_toml(tmp_path, "cosmos")
    child_toml(tmp_path, "egs")
    ws = load_workspace(
        ws_toml(
            tmp_path,
            '[workspace]\nname="s"\n[[field]]\nconfig="cosmos/fitsgl.toml"\n[[field]]\nconfig="egs/fitsgl.toml"\n',
        )
    )
    pairs = select_fields(ws, None, names_for(ws))
    assert [n for _, n in pairs] == ["cosmos", "egs"]


def test_select_fields_subset_preserves_workspace_order(tmp_path):
    child_toml(tmp_path, "cosmos")
    child_toml(tmp_path, "egs")
    ws = load_workspace(
        ws_toml(
            tmp_path,
            '[workspace]\nname="s"\n[[field]]\nconfig="cosmos/fitsgl.toml"\n[[field]]\nconfig="egs/fitsgl.toml"\n',
        )
    )
    # request egs first, cosmos twice -> workspace order, de-duplicated
    pairs = select_fields(ws, ["egs", "cosmos", "cosmos"], names_for(ws))
    assert [n for _, n in pairs] == ["cosmos", "egs"]


def test_select_fields_unknown_raises(tmp_path):
    child_toml(tmp_path, "cosmos")
    ws = load_workspace(ws_toml(tmp_path, '[workspace]\nname="s"\n[[field]]\nconfig="cosmos/fitsgl.toml"\n'))
    with pytest.raises(ValueError, match="unknown --field.*nope"):
        select_fields(ws, ["nope"], names_for(ws))


def test_select_fields_matches_prefix_override(tmp_path):
    child_toml(tmp_path, "cosmos", dataset_name="cosmos")
    ws = load_workspace(
        ws_toml(tmp_path, '[workspace]\nname="s"\n[[field]]\nconfig="cosmos/fitsgl.toml"\nprefix="c-dr1"\n')
    )
    pairs = select_fields(ws, ["c-dr1"], names_for(ws))
    assert len(pairs) == 1
