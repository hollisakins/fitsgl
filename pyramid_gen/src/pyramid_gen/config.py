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

from dataclasses import dataclass, field
from pathlib import Path

try:  # tomllib is stdlib on 3.11+; tomli is the backport for 3.10.
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - exercised only on 3.10
    import tomli as tomllib  # type: ignore[no-redef]

#: Known transfer curves (kept in lockstep with the TS ``StretchMode``).
STRETCH_MODES = ("linear", "log", "asinh")

#: Band names that would collide with a top-level output file/dir in the dataset
#: directory, so they are refused (a band becomes a subdirectory named for it).
RESERVED_BAND_NAMES = frozenset({"dataset", "catalog", "fitsgl", "index", "deploy", "embed"})


@dataclass
class BandSpec:
    """One band: a stable key + the mosaic to build a pyramid from."""

    name: str
    input: Path  # resolved relative to the toml file's directory


@dataclass
class BuildSpec:
    """``[build]`` — passes through to :func:`build_pyramid.build_pyramid`."""

    quantize_level: int = 8
    tile_size: int = 256
    #: 0 (or omitted) means auto (one worker per level, capped at cpu count).
    processes: int = 0


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
class DatasetConfig:
    """A fully-parsed, validated ``fitsgl.toml``."""

    name: str
    title: str | None
    bands: list[BandSpec]
    catalog: Path | None  # resolved relative to the toml file's directory
    build: BuildSpec
    viewer: ViewerSpec
    config_dir: Path


def _require(cond: bool, msg: str) -> None:
    if not cond:
        raise ValueError(f"fitsgl.toml: {msg}")


def _as_str(table: dict, key: str, where: str) -> str:
    v = table.get(key)
    _require(isinstance(v, str) and v != "", f"{where} must be a non-empty string")
    assert isinstance(v, str)  # for type-checkers
    return v


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
    seen: set[str] = set()
    for i, rb in enumerate(raw_bands):
        _require(isinstance(rb, dict), f"[[dataset.bands]] entry {i} is not a table")
        bname = _as_str(rb, "name", f"band {i} name")
        _require(bname not in seen, f"duplicate band name {bname!r}")
        _require(
            bname not in RESERVED_BAND_NAMES,
            f"band name {bname!r} is reserved (would collide with an output file); "
            f"reserved: {sorted(RESERVED_BAND_NAMES)}",
        )
        seen.add(bname)
        inp = _as_str(rb, "input", f"band {bname!r} input")
        inp_path = (config_dir / inp).resolve()
        if not inp_path.is_file():
            raise FileNotFoundError(f"fitsgl.toml: band {bname!r} input not found: {inp_path}")
        bands.append(BandSpec(name=bname, input=inp_path))

    catalog_path: Path | None = None
    cat = ds.get("catalog")
    if cat is not None:
        _require(isinstance(cat, str) and cat != "", "[dataset].catalog must be a path string")
        assert isinstance(cat, str)
        catalog_path = (config_dir / cat).resolve()
        if not catalog_path.is_file():
            raise FileNotFoundError(f"fitsgl.toml: [dataset].catalog not found: {catalog_path}")

    build = _parse_build(raw.get("build"))
    viewer = _parse_viewer(raw.get("viewer"), seen)

    return DatasetConfig(
        name=name,
        title=title,
        bands=bands,
        catalog=catalog_path,
        build=build,
        viewer=viewer,
        config_dir=config_dir,
    )


def _parse_build(raw: object) -> BuildSpec:
    if raw is None:
        return BuildSpec()
    _require(isinstance(raw, dict), "[build] must be a table")
    assert isinstance(raw, dict)
    out = BuildSpec()
    for key in ("quantize_level", "tile_size", "processes"):
        if key in raw:
            v = raw[key]
            _require(isinstance(v, int) and not isinstance(v, bool), f"[build].{key} must be an integer")
            setattr(out, key, v)
    _require(out.quantize_level > 0, "[build].quantize_level must be positive")
    _require(out.tile_size > 0, "[build].tile_size must be positive")
    _require(out.processes >= 0, "[build].processes must be >= 0 (0 = auto)")
    return out


def _parse_viewer(raw: object, band_names: set[str]) -> ViewerSpec:
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
        _require(v in band_names, f"[viewer].{key} references unknown band {v!r}")
        return v

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
