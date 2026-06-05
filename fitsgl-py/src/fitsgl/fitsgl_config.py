"""Emit ``fitsgl.json`` — the FitsglConfig producer contract.

This is the Python writer for the exact wire format the TypeScript
``fitsgl-core/src/fitsgl-config.ts`` validates + loads (camelCase keys:
``schemaVersion``, ``defaultView``, ``grid.pixelScaleArcsec``, ``northUp``). It
sits above the per-band ``manifest.json`` files: the dataset inventory (bands +
relative tile URLs + a grid group) plus the producer's default view.

Grid groups are assigned via the advisory ``grid_hash`` (the Python-side grouping
hint; the authoritative same-grid gate stays the client's structural
``gridsMatch`` at composite time). Bands need NOT share a grid — only RGB
compositing does — so a mixed-grid dataset is fine; the build only *warns* when
the chosen RGB default would span groups (the viewer falls back), never fails.
"""

from __future__ import annotations

import json
import os
import warnings
from pathlib import Path, PurePath

from .dataset import grid_hash
from .manifest import Manifest, read_manifest

#: The FitsglConfig schema major version (matches ``FITSGL_SCHEMA_VERSION`` in TS).
FITSGL_SCHEMA_VERSION = 1


def _relative_posix(target: Path, start: Path) -> str:
    """``target`` relative to ``start`` as a '/'-separated, in-dir URL path.

    Refuses an absolute or ``../``-escaping result so the dataset directory stays
    web-root-relocatable (the SSG/embed serve it as the root).
    """
    rel = os.path.relpath(os.fspath(target), os.fspath(start))
    posix = PurePath(rel).as_posix()
    if PurePath(posix).is_absolute() or posix == ".." or posix.startswith("../"):
        raise ValueError(f"fitsgl-config: band manifest {target} is not under the dataset dir {start}")
    return posix


def _z0(manifest: Manifest, band_name: str):
    z0 = next((lvl for lvl in manifest.levels if lvl.z == 0), None)
    if z0 is None:
        raise ValueError(f"fitsgl-config: band {band_name!r} manifest has no z=0 level")
    return z0


def assign_grid_groups(manifests: list[Manifest], band_names: list[str]) -> list[int]:
    """Group indices (0-based, by first appearance) bucketing bands by their z=0
    grid via the advisory ``grid_hash``. Co-gridded bands share a group."""
    groups: list[int] = []
    seen: dict[str, int] = {}
    for manifest, name in zip(manifests, band_names):
        z0 = _z0(manifest, name)
        h = grid_hash(z0.wcs, manifest.native_shape)
        if h not in seen:
            seen[h] = len(seen)
        groups.append(seen[h])
    return groups


def default_view_dict(
    *,
    mode: str,
    band: str | None = None,
    r: str | None = None,
    g: str | None = None,
    b: str | None = None,
    stretch: str | None = None,
    colormap: str | None = None,
    north_up: bool | None = None,
) -> dict:
    """Build the camelCase ``defaultView`` dict the contract expects."""
    dv: dict = {"mode": mode}
    if mode == "rgb":
        dv["r"], dv["g"], dv["b"] = r, g, b
    else:
        if band is not None:
            dv["band"] = band
        if colormap is not None:
            dv["colormap"] = colormap
    if stretch is not None:
        dv["stretch"] = {"mode": stretch}
    if north_up is not None:
        dv["northUp"] = north_up
    return dv


def build_fitsgl_config(
    bands: list[tuple[str, str, str | Path]],
    output_path: str | Path,
    *,
    name: str,
    default_view: dict,
    title: str | None = None,
    catalog_url: str | None = None,
    band_stats: dict[str, dict] | None = None,
    band_pivots: dict[str, float] | None = None,
) -> dict:
    """Assemble + write ``fitsgl.json`` from already-built band pyramids.

    ``bands`` are ``(name, label, manifest_path)`` triples — ``name`` is the
    URL/dir-safe slug, ``label`` the human display string (the pyramids must
    exist; this only reads their manifests). ``band_stats`` (optional) maps a band
    name to a display ``stats`` block (e.g. ``{"histogram": {...}}``) the viewer's
    stretch panel shows without a live scan. ``band_pivots`` (optional) maps a band
    name to its pivot wavelength (microns), so the viewer's trilogy rainbow can
    order filters blue→red. Band tile URLs are written RELATIVE to the output
    file's directory. Returns the config dict (also serialized to ``output_path``).
    """
    output_path = Path(output_path)
    out_dir = output_path.parent
    band_names = [n for n, _, _ in bands]
    manifests = [read_manifest(Path(p)) for _, _, p in bands]
    groups = assign_grid_groups(manifests, band_names)

    band_entries: list[dict] = []
    for (bname, blabel, mpath), manifest, group in zip(bands, manifests, groups):
        z0 = _z0(manifest, bname)
        ps = z0.pixel_scale_arcsec
        grid: dict = {"group": group}
        if isinstance(ps, (int, float)) and ps == ps and ps not in (float("inf"), float("-inf")):
            grid["pixelScaleArcsec"] = float(ps)
        entry: dict = {
            "name": bname,
            "tiles": [_relative_posix(Path(mpath), out_dir)],
            "grid": grid,
            "label": blabel,
        }
        if band_pivots is not None and bname in band_pivots:
            entry["pivotUm"] = float(band_pivots[bname])
        if band_stats is not None and bname in band_stats:
            entry["stats"] = band_stats[bname]
        band_entries.append(entry)

    dataset: dict = {"name": name, "bands": band_entries}
    if title is not None:
        dataset["title"] = title
    if catalog_url is not None:
        dataset["catalog"] = {"url": catalog_url}

    _warn_if_rgb_spans_groups(default_view, band_entries)

    config = {"schemaVersion": FITSGL_SCHEMA_VERSION, "dataset": dataset, "defaultView": default_view}
    with output_path.open("w") as f:
        # allow_nan=False: a bare NaN/Infinity token is invalid JSON the browser rejects.
        json.dump(config, f, indent=2, sort_keys=False, allow_nan=False)
        f.write("\n")
    return config


def _warn_if_rgb_spans_groups(default_view: dict, band_entries: list[dict]) -> None:
    """Warn (not fail) when the RGB default's three bands are not co-gridded —
    the composite can't form and the viewer falls back; the producer should know."""
    if default_view.get("mode") != "rgb":
        return
    group_of = {b["name"]: b["grid"]["group"] for b in band_entries}
    roles = {role: default_view.get(role) for role in ("r", "g", "b")}
    groups = {role: group_of.get(name) for role, name in roles.items() if name is not None}
    distinct = set(groups.values())
    if len(distinct) > 1:
        warnings.warn(
            "fitsgl: the default RGB view spans grid groups "
            f"({', '.join(f'{role}={roles[role]}(grid {g})' for role, g in groups.items())}) — "
            "these bands are not co-gridded, so the RGB composite cannot form and the viewer "
            "will fall back. Choose co-gridded bands for the default RGB, or set a single-band default.",
            stacklevel=2,
        )
