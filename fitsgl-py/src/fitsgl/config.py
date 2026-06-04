"""``fitsgl.toml`` — the producer's source-of-truth config for ``fitsgl build``.

One file describes a whole multi-band dataset, cleanly split into ``[dataset]``
(what data exists + where — pure inventory) and ``[viewer]`` (the overridable
default view). This module parses + validates it into typed dataclasses; the
build orchestrator (``build.py``) consumes them. No FITS/IO here beyond reading
the toml, so it unit-tests trivially.

The split mirrors the emitted contract (``fitsgl.json`` / ``fitsgl_config.py``):
the data never dictates the view — RGB role assignment, stretch, and colormap are
live view state, and ``[viewer]`` only sets the initial state.
"""

from __future__ import annotations

import re
import warnings
from dataclasses import dataclass
from pathlib import Path

try:  # tomllib is stdlib on 3.11+; tomli is the backport for 3.10.
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - exercised only on 3.10
    import tomli as tomllib  # type: ignore[no-redef]

from .deploy_plan import DEFAULT_SWR_GRACE, DEFAULT_TILE_MAX_AGE  # CDN cache-window defaults (lightweight, no astropy)

#: Known transfer curves (kept in lockstep with the TS ``StretchMode``).
STRETCH_MODES = ("linear", "log", "asinh")

#: Band names that would collide with a top-level output file/dir in the dataset
#: directory, so they are refused (a band becomes a subdirectory named for it).
#: ``index``/``assets`` are the bundled SSG viewer's files; ``fitsgl`` is ``fitsgl.json``.
RESERVED_BAND_NAMES = frozenset({"dataset", "catalog", "fitsgl", "index", "assets", "deploy", "embed"})

#: Characters not allowed in a band's on-disk/URL slug (everything else -> ``_``).
_UNSAFE = re.compile(r"[^A-Za-z0-9_-]")


def slugify_band_name(name: str) -> str:
    """A URL- and directory-safe slug for ``name`` (non-``[A-Za-z0-9_-]`` -> ``_``).

    Case-preserving and 1:1 (no reserved-dodge, no dedup); :func:`load_config`
    validates the result against :data:`RESERVED_BAND_NAMES` and uniqueness itself,
    so a reserved/colliding slug surfaces as a pointed error, not a silent rename.
    """
    return _UNSAFE.sub("_", name) or "band"


def sanitize_band_name(stem: str, taken: set[str]) -> str:
    """A TOML/dir-safe, unique band key derived from a filename stem (for ``init``).

    :func:`slugify_band_name` plus a reserved-name dodge and de-duplication against
    ``taken`` — lenient auto-fixing suited to scaffolding from filenames, where a
    pointed error would be unhelpful.
    """
    base = slugify_band_name(stem)
    if base in RESERVED_BAND_NAMES:
        base = f"{base}_1"
    candidate = base
    i = 2
    while candidate in taken:
        candidate = f"{base}_{i}"
        i += 1
    return candidate


@dataclass
class BandSpec:
    """One band: a stable URL/dir-safe key, a human label, and its source mosaic(s)."""

    name: str  # slug — used for the on-disk subdir, tile URLs, and defaultView refs
    inputs: list[Path]  # one mosaic, or several pre-tiled tiles; resolved vs the toml dir
    label: str  # human-readable display name (defaults to the original toml name)


@dataclass
class BuildSpec:
    """``[build]`` — passes through to :func:`build_pyramid.build_pyramid`."""

    quantize_level: int = 8
    tile_size: int = 256
    #: Max render-tiles per side per supertile file. ``None`` → the builder's default
    #: (``build_pyramid.DEFAULT_SUPERTILE_BLOCKS``); set to override.
    supertile_blocks: int | None = None


@dataclass
class ViewerSpec:
    """``[viewer]`` — the default view (overridable live in the viewer)."""

    mode: str = "single"  # "single" | "rgb"
    band: str | None = None  # single
    r: str | None = None  # rgb
    g: str | None = None
    b: str | None = None
    stretch: str | None = None  # linear | log | asinh
    colormap: str | None = None  # single only
    north_up: bool | None = None


@dataclass
class DeployConfig:
    """``[deploy]`` — where + how ``fitsgl deploy`` pushes to Cloudflare R2.

    Identifiers only; secrets come from the environment (``R2_ACCESS_KEY_ID`` /
    ``R2_SECRET_ACCESS_KEY`` / ``CLOUDFLARE_API_TOKEN``). Lives here (not in
    ``deploy.py``) so ``config.py`` owns every TOML-parsed structure; ``deploy.py``
    re-exports it. ``zone_id`` is optional — without it (and a token) the edge purge
    is skipped. ``swr_grace`` is not a TOML knob (only ``tile_max_age`` is, per the
    design); it stays at the default.
    """

    bucket: str
    endpoint: str
    public_url: str
    zone_id: str | None = None
    prefix: str = ""  # optional key prefix within the bucket
    viewer_origin: str = "*"  # CORS Allow-Origin (DP8)
    tile_max_age: int = DEFAULT_TILE_MAX_AGE
    swr_grace: int = DEFAULT_SWR_GRACE
    target: str = "r2"  # only "r2" in v1


@dataclass
class DatasetConfig:
    """A fully-parsed, validated ``fitsgl.toml``."""

    name: str
    title: str | None
    bands: list[BandSpec]
    catalog: Path | None  # resolved relative to the toml file's directory
    build: BuildSpec
    viewer: ViewerSpec
    config_dir: Path
    deploy: DeployConfig | None = None  # None when [deploy] is absent


def _require(cond: bool, msg: str) -> None:
    if not cond:
        raise ValueError(f"fitsgl.toml: {msg}")


def _as_str(table: dict, key: str, where: str) -> str:
    v = table.get(key)
    _require(isinstance(v, str) and v != "", f"{where} must be a non-empty string")
    assert isinstance(v, str)  # for type-checkers
    return v


def _resolve_band_inputs(rb: dict, bname: str, config_dir: Path) -> list[Path]:
    """Resolve a band's ``input`` to ≥1 existing FITS paths (relative to the toml dir).

    Accepts a single path string, a list of path strings, or a glob (``*?[``) — globs
    expand sorted. Multiple inputs are pre-tiled tiles placed onto one grid at build
    time. De-duplicates while preserving order; raises if a path/glob resolves to none.
    """
    raw = rb.get("input")
    _require(raw is not None, f"band {bname!r} is missing 'input'")
    entries = raw if isinstance(raw, list) else [raw]
    _require(
        len(entries) > 0 and all(isinstance(e, str) and e != "" for e in entries),
        f"band {bname!r} input must be a non-empty path string or list of path strings",
    )
    paths: list[Path] = []
    seen: set[Path] = set()
    for e in entries:
        if any(ch in e for ch in "*?["):
            matched = sorted(config_dir.glob(e))
            if not matched:
                raise FileNotFoundError(
                    f"fitsgl.toml: band {bname!r} input glob {e!r} matched no files under {config_dir}"
                )
            candidates = matched
        else:
            candidates = [config_dir / e]
        for c in candidates:
            cr = c.resolve()
            if not cr.is_file():
                raise FileNotFoundError(f"fitsgl.toml: band {bname!r} input not found: {cr}")
            if cr not in seen:
                seen.add(cr)
                paths.append(cr)
    return paths


def load_config(path: str | Path) -> DatasetConfig:
    """Parse and validate a ``fitsgl.toml`` at ``path``.

    Raises ``FileNotFoundError`` if the file (or a band input) is missing, and
    ``ValueError`` with a pointed message on any schema problem.
    """
    path = Path(path)
    if not path.is_file():
        raise FileNotFoundError(f"fitsgl.toml not found: {path}")
    config_dir = path.parent
    with path.open("rb") as f:
        raw = tomllib.load(f)

    ds = raw.get("dataset")
    _require(isinstance(ds, dict), 'missing or invalid [dataset] table')
    assert isinstance(ds, dict)
    name = _as_str(ds, "name", "[dataset].name")
    title = ds.get("title")
    _require(title is None or isinstance(title, str), "[dataset].title must be a string")

    raw_bands = ds.get("bands")
    _require(isinstance(raw_bands, list) and len(raw_bands) > 0, "[dataset] needs at least one [[dataset.bands]]")
    assert isinstance(raw_bands, list)
    bands: list[BandSpec] = []
    seen_raw: set[str] = set()
    seen_slugs: set[str] = set()
    alias: dict[str, str] = {}  # original name OR slug -> slug, for [viewer] ref resolution
    for i, rb in enumerate(raw_bands):
        _require(isinstance(rb, dict), f"[[dataset.bands]] entry {i} is not a table")
        bname = _as_str(rb, "name", f"band {i} name")
        _require(bname not in seen_raw, f"duplicate band name {bname!r}")
        seen_raw.add(bname)
        slug = slugify_band_name(bname)
        _require(
            slug not in RESERVED_BAND_NAMES,
            f"band name {bname!r} is reserved (would collide with an output file); "
            f"reserved: {sorted(RESERVED_BAND_NAMES)}",
        )
        _require(slug not in seen_slugs, f"band name {bname!r} slugs to {slug!r}, which collides with another band")
        seen_slugs.add(slug)
        rlabel = rb.get("label")
        _require(
            rlabel is None or (isinstance(rlabel, str) and rlabel != ""),
            f"band {bname!r} label must be a non-empty string",
        )
        if slug != bname and rlabel is None:
            warnings.warn(
                f"fitsgl.toml: band name {bname!r} is not URL-safe; using {slug!r} for the "
                f"directory/tile URLs and {bname!r} as the display label (set an explicit "
                "`label` to silence this)",
                stacklevel=2,
            )
        inp_paths = _resolve_band_inputs(rb, bname, config_dir)
        bands.append(BandSpec(name=slug, inputs=inp_paths, label=rlabel if rlabel is not None else bname))
        alias[bname] = slug
        alias[slug] = slug

    catalog_path: Path | None = None
    cat = ds.get("catalog")
    if cat is not None:
        _require(isinstance(cat, str) and cat != "", "[dataset].catalog must be a path string")
        assert isinstance(cat, str)
        catalog_path = (config_dir / cat).resolve()
        if not catalog_path.is_file():
            raise FileNotFoundError(f"fitsgl.toml: [dataset].catalog not found: {catalog_path}")

    build = _parse_build(raw.get("build"))
    viewer = _parse_viewer(raw.get("viewer"), alias)
    deploy = _parse_deploy(raw.get("deploy"))

    return DatasetConfig(
        name=name,
        title=title,
        bands=bands,
        catalog=catalog_path,
        build=build,
        viewer=viewer,
        config_dir=config_dir,
        deploy=deploy,
    )


def _parse_deploy(raw: object) -> DeployConfig | None:
    """Parse the optional ``[deploy]`` table; ``None`` when it's absent.

    Validates identifiers only (no secrets). ``bucket``/``endpoint``/``public_url``
    are required; ``zone_id``/``prefix``/``viewer_origin`` optional strings;
    ``tile_max_age`` an optional positive int; ``target`` must be ``"r2"``.
    """
    if raw is None:
        return None
    _require(isinstance(raw, dict), "[deploy] must be a table")
    assert isinstance(raw, dict)

    target = raw.get("target", "r2")
    _require(target == "r2", '[deploy].target must be "r2" (the only supported target)')

    out = DeployConfig(
        bucket=_as_str(raw, "bucket", "[deploy].bucket"),
        endpoint=_as_str(raw, "endpoint", "[deploy].endpoint"),
        public_url=_as_str(raw, "public_url", "[deploy].public_url"),
        target="r2",
    )

    for key in ("zone_id", "viewer_origin"):
        if key in raw:
            v = raw[key]
            _require(isinstance(v, str) and v != "", f"[deploy].{key} must be a non-empty string")
            setattr(out, key, v)
    if "prefix" in raw:  # "" is valid (= no prefix, the default) — so the init stub round-trips
        v = raw["prefix"]
        _require(isinstance(v, str), "[deploy].prefix must be a string")
        out.prefix = v

    if "tile_max_age" in raw:
        v = raw["tile_max_age"]
        _require(isinstance(v, int) and not isinstance(v, bool) and v > 0, "[deploy].tile_max_age must be a positive integer")
        out.tile_max_age = v

    return out


def _parse_build(raw: object) -> BuildSpec:
    if raw is None:
        return BuildSpec()
    _require(isinstance(raw, dict), "[build] must be a table")
    assert isinstance(raw, dict)
    out = BuildSpec()
    for key in ("quantize_level", "tile_size", "supertile_blocks"):
        if key in raw:
            v = raw[key]
            _require(isinstance(v, int) and not isinstance(v, bool), f"[build].{key} must be an integer")
            setattr(out, key, v)
    _require(out.quantize_level > 0, "[build].quantize_level must be positive")
    _require(out.tile_size > 0, "[build].tile_size must be positive")
    _require(
        out.supertile_blocks is None or out.supertile_blocks >= 1,
        "[build].supertile_blocks must be >= 1",
    )
    return out


def _parse_viewer(raw: object, band_alias: dict[str, str]) -> ViewerSpec:
    if raw is None:
        # No [viewer]: default to single-band on the first band (resolved by the emitter).
        return ViewerSpec(mode="single")
    _require(isinstance(raw, dict), "[viewer] must be a table")
    assert isinstance(raw, dict)
    mode = raw.get("default", "single")
    _require(mode in ("single", "rgb"), '[viewer].default must be "single" or "rgb"')
    out = ViewerSpec(mode=mode)

    def ref(key: str) -> str | None:
        v = raw.get(key)
        if v is None:
            return None
        _require(isinstance(v, str), f"[viewer].{key} must be a band name string")
        assert isinstance(v, str)
        _require(v in band_alias, f"[viewer].{key} references unknown band {v!r}")
        return band_alias[v]  # resolve to the slug so it matches the band dirs/defaultView

    if mode == "rgb":
        for key in ("r", "g", "b"):
            val = ref(key)
            _require(val is not None, f'[viewer].{key} is required when default = "rgb"')
            setattr(out, key, val)
    else:
        out.band = ref("band")  # optional; emitter defaults to the first band

    stretch = raw.get("stretch")
    if stretch is not None:
        _require(stretch in STRETCH_MODES, f"[viewer].stretch must be one of {STRETCH_MODES}")
        out.stretch = stretch
    colormap = raw.get("colormap")
    if colormap is not None:
        _require(isinstance(colormap, str), "[viewer].colormap must be a string")
        _require(mode == "single", "[viewer].colormap applies to single-band mode only")
        out.colormap = colormap
    north_up = raw.get("north_up")
    if north_up is not None:
        _require(isinstance(north_up, bool), "[viewer].north_up must be a boolean")
        out.north_up = north_up
    return out
