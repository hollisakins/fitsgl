"""``fitsgl.workspace.toml`` — one R2 bucket, many fields under distinct prefixes.

A workspace references **existing** per-field ``fitsgl.toml`` files (it never inlines
a dataset). It holds a SHARED ``[deploy]`` block whose ``base_url`` derives each
field's ``public_url`` (= ``base_url/prefix``), so the producer can never make a
field's prefix and its served URL drift apart. ``fitsgl build|deploy|index -w
workspace.toml`` loops the fields, delegating to the unchanged per-dataset
``build_dataset()`` / ``deploy_dataset()``.

Invariant preserved: one field = one child ``fitsgl.toml`` = one prefix = one ledger
(``<prefix>/deploy-manifest.json``). This module owns only the workspace TOML
structure + the prefix/public_url derivation; it stays **lazy** — it validates
structure and resolves child paths but does not call :func:`config.load_config`
(which stats every band's FITS input), so a subset build/deploy needs only the
selected fields' inputs present. See ``docs/workspace-design.md``.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

try:  # tomllib is stdlib on 3.11+; tomli is the backport for 3.10.
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - exercised only on 3.10
    import tomli as tomllib  # type: ignore[no-redef]

from .config import DeployConfig, slugify_band_name
from .deploy_plan import (
    DEFAULT_SWR_GRACE,
    DEFAULT_TILE_MAX_AGE,
    DEFAULT_UPLOAD_CONCURRENCY,
)

#: Prefixes a field may never use: each collides with a root-level object the
#: collection deploy writes at bucket prefix "". ``""``/``"."`` collide with the
#: root ledger (``deploy-manifest.json``) + the picker ``index.html``; ``assets``
#: with the bundle dir; ``index``/``collection`` with the landing files.
RESERVED_FIELD_PREFIXES = frozenset({"", ".", "assets", "index", "collection"})


@dataclass
class WorkspaceDeploy:
    """The SHARED ``[deploy]`` block of a workspace.

    Like :class:`config.DeployConfig` but with ``base_url`` instead of a fixed
    ``public_url`` and NO ``prefix`` (both are per-field; derived by
    :func:`field_deploy_config`). ``swr_grace`` stays at the default, matching the
    per-dataset config (it is not a TOML knob there either).
    """

    bucket: str
    endpoint: str
    base_url: str
    zone_id: str | None = None
    viewer_origin: str = "*"
    tile_max_age: int = DEFAULT_TILE_MAX_AGE
    swr_grace: int = DEFAULT_SWR_GRACE
    concurrency: int = DEFAULT_UPLOAD_CONCURRENCY
    target: str = "r2"


@dataclass
class CollectionConfig:
    """``[collection]`` — the landing page's header (name + optional title)."""

    name: str
    title: str | None = None


@dataclass
class FieldRef:
    """One ``[[field]]``: a pointer to a child ``fitsgl.toml`` + optional overrides.

    ``config_path`` is resolved absolute (relative to the workspace file's dir).
    ``prefix``/``title`` are the explicit overrides; the effective values are
    computed by :func:`field_prefix` / :func:`field_title` against the child's
    peeked ``dataset.name`` so the defaults fall back to the child's identity.
    """

    config_path: Path
    prefix: str | None = None  # None => default to child dataset.name
    title: str | None = None  # None => default to child title, then child name


@dataclass
class WorkspaceConfig:
    """A fully-parsed, validated ``fitsgl.workspace.toml`` (children not yet loaded)."""

    name: str
    title: str | None
    fields: list[FieldRef]
    config_dir: Path
    deploy: WorkspaceDeploy | None = None  # None when [deploy] is absent
    collection: CollectionConfig | None = None  # None when [collection] is absent


def _require(cond: bool, msg: str) -> None:
    if not cond:
        raise ValueError(f"fitsgl.workspace.toml: {msg}")


def _as_str(table: dict, key: str, where: str) -> str:
    v = table.get(key)
    _require(isinstance(v, str) and v != "", f"{where} must be a non-empty string")
    assert isinstance(v, str)  # for type-checkers
    return v


def load_workspace(path: str | Path) -> WorkspaceConfig:
    """Parse + validate a ``fitsgl.workspace.toml`` (does NOT load child configs).

    Validates the workspace structure, resolves each ``[[field]].config`` to an
    absolute path, and checks the child file exists — but does not call
    :func:`config.load_config` (which would stat every band's FITS input). Callers
    load children on demand (build) or peek just the name (deploy/index). Raises
    ``FileNotFoundError`` (missing workspace or a referenced child toml) /
    ``ValueError`` (schema problems).
    """
    path = Path(path)
    if not path.is_file():
        raise FileNotFoundError(f"fitsgl.workspace.toml not found: {path}")
    config_dir = path.parent
    with path.open("rb") as f:
        raw = tomllib.load(f)

    ws = raw.get("workspace")
    _require(isinstance(ws, dict), "missing or invalid [workspace] table")
    assert isinstance(ws, dict)
    name = _as_str(ws, "name", "[workspace].name")
    title = ws.get("title")
    _require(title is None or isinstance(title, str), "[workspace].title must be a string")

    deploy = _parse_workspace_deploy(raw.get("deploy"))
    collection = _parse_collection(raw.get("collection"), default_name=name)

    raw_fields = raw.get("field")
    _require(isinstance(raw_fields, list) and len(raw_fields) > 0, "a workspace needs at least one [[field]]")
    assert isinstance(raw_fields, list)
    fields: list[FieldRef] = []
    seen_paths: set[Path] = set()
    for i, rf in enumerate(raw_fields):
        _require(isinstance(rf, dict), f"[[field]] entry {i} is not a table")
        assert isinstance(rf, dict)
        cfg = _as_str(rf, "config", f"[[field]] {i} config")
        cfg_path = (config_dir / cfg).resolve()
        if not cfg_path.is_file():
            raise FileNotFoundError(f"fitsgl.workspace.toml: [[field]] {i} config not found: {cfg_path}")
        _require(cfg_path not in seen_paths, f"[[field]] config {cfg!r} is referenced more than once")
        seen_paths.add(cfg_path)

        prefix = rf.get("prefix")
        if prefix is not None:
            _require(isinstance(prefix, str) and prefix != "", f"[[field]] {i} prefix must be a non-empty string")
        ftitle = rf.get("title")
        _require(
            ftitle is None or (isinstance(ftitle, str) and ftitle != ""),
            f"[[field]] {i} title must be a non-empty string",
        )
        fields.append(FieldRef(config_path=cfg_path, prefix=prefix, title=ftitle))

    return WorkspaceConfig(
        name=name, title=title, fields=fields, config_dir=config_dir, deploy=deploy, collection=collection
    )


def _parse_workspace_deploy(raw: object) -> WorkspaceDeploy | None:
    """Parse the shared ``[deploy]`` (``None`` when absent).

    Mirrors :func:`config._parse_deploy` but with ``base_url`` (not ``public_url``)
    and no ``prefix`` — both are per-field. Rejects a stray ``public_url``/``prefix``
    with a pointed message so a copy-pasted per-dataset ``[deploy]`` fails loudly.
    """
    if raw is None:
        return None
    _require(isinstance(raw, dict), "[deploy] must be a table")
    assert isinstance(raw, dict)
    _require(raw.get("target", "r2") == "r2", '[deploy].target must be "r2" (the only supported target)')
    _require(
        "public_url" not in raw,
        "[deploy] in a workspace uses base_url, not public_url (each field's "
        "public_url is derived as base_url/prefix)",
    )
    _require(
        "prefix" not in raw,
        "[deploy] in a workspace has no prefix — it is per-field (default = the "
        "field's dataset name; override with [[field]].prefix)",
    )

    out = WorkspaceDeploy(
        bucket=_as_str(raw, "bucket", "[deploy].bucket"),
        endpoint=_as_str(raw, "endpoint", "[deploy].endpoint"),
        base_url=_as_str(raw, "base_url", "[deploy].base_url"),
        target="r2",
    )
    for key in ("zone_id", "viewer_origin"):
        if key in raw:
            v = raw[key]
            _require(isinstance(v, str) and v != "", f"[deploy].{key} must be a non-empty string")
            setattr(out, key, v)
    for key in ("tile_max_age", "concurrency"):
        if key in raw:
            v = raw[key]
            _require(
                isinstance(v, int) and not isinstance(v, bool) and v > 0,
                f"[deploy].{key} must be a positive integer",
            )
            setattr(out, key, v)
    return out


def _parse_collection(raw: object, *, default_name: str) -> CollectionConfig | None:
    """Parse the optional ``[collection]`` table (``None`` when absent).

    ``name`` defaults to the workspace name, ``title`` to ``name``. Absent table →
    ``None``; the ``index`` command then falls back to the workspace name/title.
    """
    if raw is None:
        return None
    _require(isinstance(raw, dict), "[collection] must be a table")
    assert isinstance(raw, dict)
    name = raw.get("name", default_name)
    _require(isinstance(name, str) and name != "", "[collection].name must be a non-empty string")
    title = raw.get("title")
    _require(title is None or (isinstance(title, str) and title != ""), "[collection].title must be a non-empty string")
    return CollectionConfig(name=name, title=title)


# ----------------------------------------------------------- per-field derivation


def field_prefix(ref: FieldRef, dataset_name: str) -> str:
    """The bucket key prefix for a field: the explicit override, else the child
    ``dataset.name`` (the field's identity)."""
    return ref.prefix if ref.prefix is not None else dataset_name


def field_public_url(ws_deploy: WorkspaceDeploy, prefix: str) -> str:
    """The served base URL for a field = ``base_url/prefix`` (slash-normalized).

    The single line that removes the manual-sync footgun: the producer sets
    ``base_url`` once and every field's ``public_url`` follows its prefix.
    """
    return f"{ws_deploy.base_url.rstrip('/')}/{prefix.strip('/')}"


def field_title(ref: FieldRef, dataset_name: str, dataset_title: str | None = None) -> str:
    """The landing-card title: override, else child title, else child name."""
    return ref.title or dataset_title or dataset_name


def field_deploy_config(ws: WorkspaceConfig, ref: FieldRef, dataset_name: str) -> DeployConfig:
    """Project the shared workspace ``[deploy]`` + a field into a per-dataset
    :class:`config.DeployConfig` that :func:`deploy.deploy_dataset` consumes
    UNCHANGED.

    The derived ``prefix`` + ``public_url`` are baked in here from the single
    resolved prefix, so they cannot drift. The per-field ledger key falls out
    automatically: ``object_key(prefix, "deploy-manifest.json")`` with a unique
    prefix ⇒ a unique ledger ⇒ the one-prefix-one-ledger invariant.
    """
    if ws.deploy is None:
        raise ValueError("fitsgl.workspace.toml: [deploy] is required to deploy (add a [deploy] table)")
    prefix = field_prefix(ref, dataset_name)
    return DeployConfig(
        bucket=ws.deploy.bucket,
        endpoint=ws.deploy.endpoint,
        public_url=field_public_url(ws.deploy, prefix),
        zone_id=ws.deploy.zone_id,
        prefix=prefix,
        viewer_origin=ws.deploy.viewer_origin,
        tile_max_age=ws.deploy.tile_max_age,
        swr_grace=ws.deploy.swr_grace,
        concurrency=ws.deploy.concurrency,
        target="r2",
    )


# ------------------------------------------------- cross-field validation + select


def validate_workspace_fields(ws: WorkspaceConfig, dataset_names: list[str]) -> None:
    """Cross-field invariants that need each child's peeked ``dataset.name``.

    ``dataset_names[i]`` is the ``[dataset].name`` of ``ws.fields[i]`` (from
    :func:`config.read_dataset_name`). Enforces, before any filesystem/network
    writes:

    * each effective prefix is non-empty, slug-safe, and not reserved (an empty/
      reserved prefix collides with the collection root at bucket prefix "");
    * effective prefixes are unique (else two fields share a ledger and each deploy
      deletes the other's tiles as orphans);
    * child ``dataset.name`` are unique (else two fields build into the same
      ``out/<name>/`` and clobber each other).
    """
    _require(len(dataset_names) == len(ws.fields), "internal: dataset_names must match fields")
    seen_prefix: dict[str, Path] = {}
    seen_name: dict[str, Path] = {}
    for ref, dsname in zip(ws.fields, dataset_names):
        # dataset.name uniqueness first: a collision is the root cause (it also makes
        # the default prefixes collide), so report it rather than the derived prefix clash.
        if dsname in seen_name:
            raise ValueError(
                f"fitsgl.workspace.toml: {seen_name[dsname].name} and {ref.config_path.name} both have "
                f"dataset.name {dsname!r} — they would build into the same out/{dsname}/ and overwrite "
                "each other; rename one dataset"
            )
        seen_name[dsname] = ref.config_path
        prefix = field_prefix(ref, dsname)
        _require(
            prefix not in RESERVED_FIELD_PREFIXES,
            f"field {ref.config_path.name} prefix {prefix!r} is reserved (it would collide with "
            f"the collection root at the bucket root); reserved: {sorted(RESERVED_FIELD_PREFIXES)} "
            "— set an explicit [[field]].prefix",
        )
        _require(
            prefix == slugify_band_name(prefix),
            f"field {ref.config_path.name} prefix {prefix!r} is not a clean URL/key segment "
            f"(would become {slugify_band_name(prefix)!r}); rename the dataset or set an explicit "
            "[[field]].prefix using only [A-Za-z0-9_-]",
        )
        if prefix in seen_prefix:
            raise ValueError(
                f"fitsgl.workspace.toml: {seen_prefix[prefix].name} and {ref.config_path.name} resolve "
                f"to the same prefix {prefix!r} — each field needs a unique prefix (it is the bucket "
                "key prefix AND the deploy ledger key); set [[field]].prefix to disambiguate"
            )
        seen_prefix[prefix] = ref.config_path


def select_fields(
    ws: WorkspaceConfig, requested: list[str] | None, dataset_names: list[str]
) -> list[tuple[FieldRef, str]]:
    """Resolve ``--field`` selectors to ``(field, dataset_name)`` pairs in workspace
    order.

    Selectors match a field's effective **prefix** (= ``dataset.name`` by default).
    ``requested=None`` selects all fields. De-duplicates while preserving workspace
    order (so ``--field a --field a`` selects once). Raises ``ValueError`` naming the
    unknown selector(s) and listing the valid prefixes.
    """
    pairs = list(zip(ws.fields, dataset_names))
    if requested is None:
        return pairs
    by_prefix = {field_prefix(ref, dsname): (ref, dsname) for ref, dsname in pairs}
    unknown = [n for n in requested if n not in by_prefix]
    if unknown:
        valid = ", ".join(sorted(by_prefix))
        raise ValueError(f"unknown --field {unknown!r}; workspace fields: {valid}")
    chosen = set(requested)
    return [(ref, dsname) for ref, dsname in pairs if field_prefix(ref, dsname) in chosen]
