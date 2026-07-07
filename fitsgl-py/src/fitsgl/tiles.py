"""Read-side tile geometry: level selection and supertile / tile addressing.

This is the Python mirror of the TypeScript client's pure tile math
(``fitsgl-core/src/renderer/tile-manager.ts`` and ``…/manifest.ts``). A
server-side reader — the CAMPFIRE cutout service (issue #17) — needs the same
answers the browser computes for itself: *which pyramid level* matches a
requested output scale, *which fpack tiles* of that level cover a pixel region,
and *which supertile file* holds each of those tiles (with the tile's
supertile-local coordinates).

Everything here is pure geometry: no astropy, no HTTP, no file IO. It operates
on a parsed :class:`~fitsgl.manifest.Manifest`. Sky <-> pixel projection (the one
piece that genuinely needs a WCS engine) lives in :mod:`fitsgl.cutout`, which
uses astropy; byte-range addressing *within* a supertile lives in
:mod:`fitsgl.fpack_index`. Keeping this module dependency-free lets a consumer
do all the level/tile bookkeeping without pulling in astropy.

Coordinate conventions (matching the pipeline and the browser client):

* A level's pixel grid is 0-based, ``level.shape == [H, W]``. Pixel column
  ``x`` (0..W-1) and row ``y`` (0..H-1).
* Every level is tiled in ``tile_size``-pixel (default 256) fpack tiles. Tile
  ``(tile_x, tile_y)`` covers level pixels ``[tile_x*ts, (tile_x+1)*ts)`` in x
  and ``[tile_y*ts, (tile_y+1)*ts)`` in y, clamped to the level's dimensions —
  high-index edge tiles are smaller. ``level.fpack_tile_count == [n_ty, n_tx]``.
* A level's tiles are partitioned into disjoint *supertiles* (standalone
  ``.fits.fz`` rectangles). A v1 / single-file level is one supertile covering
  the whole grid. :func:`resolve_supertile` maps a global tile to the supertile
  that holds it plus the tile's coordinates *local* to that supertile's own grid
  — the coordinates the ``.fits.fz`` addresses its fpack tiles by.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Literal, Optional

from .manifest import LevelInfo, Manifest, SupertileInfo

#: Default fpack-internal tile edge in level pixels (the unit of HTTP byte
#: ranges). Mirrors ``FPACK_TILE_SIZE`` in ``build_pyramid``. A dataset built
#: with a non-default ``[build] tile_size`` records the true value in
#: ``manifest.fpack_tile_size`` — the authoritative source for the tile geometry
#: functions here; this constant is only the fallback default.
TILE_SIZE = 256

#: How :func:`select_level_index` breaks a tie between two pyramid levels.
#: ``"nearest"`` matches the browser's ``targetLevel`` (the closest scale in log
#: space — one level pixel ≈ one output pixel). ``"finer"`` never upsamples
#: (picks a level at least as fine as the request, so the cutout is downsampled
#: in numpy, never blown up). ``"coarser"`` never downsamples the source below
#: the request.
Rounding = Literal["nearest", "finer", "coarser"]


@dataclass(frozen=True)
class TileCoord:
    """A single fpack tile of a level, in the level's *global* tile grid."""

    level: int
    tile_x: int
    tile_y: int


@dataclass(frozen=True)
class PixelBBox:
    """A half-open pixel rectangle ``[x0, x1) x [y0, y1)`` in a level's grid.

    ``x0/y0`` are inclusive, ``x1/y1`` exclusive (like a numpy slice). An empty
    box has ``x1 <= x0`` or ``y1 <= y0``.
    """

    x0: int
    y0: int
    x1: int
    y1: int

    @property
    def width(self) -> int:
        return max(0, self.x1 - self.x0)

    @property
    def height(self) -> int:
        return max(0, self.y1 - self.y0)

    @property
    def is_empty(self) -> bool:
        return self.x1 <= self.x0 or self.y1 <= self.y0


@dataclass(frozen=True)
class SupertileMatch:
    """The supertile covering a global tile, plus that tile's supertile-local coords.

    Mirror of the TS ``SupertileMatch`` (``manifest.ts``). ``local_x/local_y`` are
    the tile's coordinates in the supertile's *own* tile grid — the coordinates
    the standalone ``.fits.fz`` file addresses its fpack tiles by (see
    :mod:`fitsgl.fpack_index`).
    """

    supertile: SupertileInfo
    #: Index of the supertile within ``level.supertiles``.
    index: int
    local_x: int
    local_y: int


def level_tile_grid(level: LevelInfo) -> tuple[int, int]:
    """``(n_tiles_x, n_tiles_y)`` for a level (unpacks ``fpack_tile_count`` = [n_ty, n_tx])."""
    n_ty, n_tx = level.fpack_tile_count
    return int(n_tx), int(n_ty)


def resolve_supertile(level: LevelInfo, tile_x: int, tile_y: int) -> Optional[SupertileMatch]:
    """Find the supertile of ``level`` containing global tile ``(tile_x, tile_y)``.

    Returns the match (with supertile-local coordinates) or ``None`` when no
    supertile covers the tile — either out of the level grid, or an in-grid *gap*
    an all-NaN supertile was dropped from (a band covering only part of a shared
    grid). A linear scan, exactly like the client's ``resolveSupertile``: a level
    has at most a few hundred supertiles. Supertiles are disjoint, so the first
    (only) containing match is authoritative.
    """
    for index, st in enumerate(level.supertiles):
        tx0, ty0 = st.tile_origin
        snx, sny = st.tile_count
        if tx0 <= tile_x < tx0 + snx and ty0 <= tile_y < ty0 + sny:
            return SupertileMatch(supertile=st, index=index, local_x=tile_x - tx0, local_y=tile_y - ty0)
    return None


def tile_pixel_bounds(level: LevelInfo, tile_x: int, tile_y: int, tile_size: int = TILE_SIZE) -> PixelBBox:
    """Level-pixel rectangle a tile covers, clamped to the level's dimensions.

    High-index edge tiles are smaller than ``tile_size`` because the level's
    pixel dimensions need not be a multiple of it (astropy stores them at their
    true size).
    """
    h, w = level.shape
    x0 = tile_x * tile_size
    y0 = tile_y * tile_size
    return PixelBBox(x0=x0, y0=y0, x1=min(x0 + tile_size, int(w)), y1=min(y0 + tile_size, int(h)))


def pixel_to_tile(
    level: LevelInfo, px: int, py: int, tile_size: int = TILE_SIZE
) -> Optional[TileCoord]:
    """The tile holding 0-based level pixel ``(px, py)``, or ``None`` if outside the grid."""
    h, w = level.shape
    if px < 0 or py < 0 or px >= int(w) or py >= int(h):
        return None
    return TileCoord(level=level.z, tile_x=px // tile_size, tile_y=py // tile_size)


def tiles_for_pixel_bbox(
    level: LevelInfo, bbox: PixelBBox, tile_size: int = TILE_SIZE
) -> list[TileCoord]:
    """Every tile of ``level`` overlapping the half-open pixel box ``bbox``.

    The box is intersected with the level's imaged area first, so an
    out-of-bounds or empty request yields ``[]``. Tiles are returned row-major
    (y outer, x inner). This enumerates *global* tiles; call
    :func:`resolve_supertile` on each to find its file, and expect ``None`` for
    tiles that fall in a dropped-supertile gap.

    ``tile_size`` MUST be the size the level was tiled at
    (``manifest.fpack_tile_size``, default 256) — the unit ``fpack_tile_count``
    and every supertile ``tile_origin``/``tile_count`` are expressed in. Passing a
    different value yields tile indices that :func:`resolve_supertile` cannot
    interpret, silently under-covering the box. Prefer :func:`fitsgl.cutout.plan_cutout`,
    which reads the size from the manifest for you.
    """
    n_tx, n_ty = level_tile_grid(level)
    h, w = int(level.shape[0]), int(level.shape[1])

    # Clamp the request to the imaged area (half-open).
    x0 = max(0, bbox.x0)
    y0 = max(0, bbox.y0)
    x1 = min(w, bbox.x1)
    y1 = min(h, bbox.y1)
    if x1 <= x0 or y1 <= y0:
        return []

    tx0 = x0 // tile_size
    ty0 = y0 // tile_size
    # x1/y1 are exclusive: the last covered pixel is x1-1, whose tile is the
    # last column to include (so a box ending exactly on a tile boundary does
    # not pull in the next, untouched column).
    tx1 = min(n_tx - 1, (x1 - 1) // tile_size)
    ty1 = min(n_ty - 1, (y1 - 1) // tile_size)

    tiles: list[TileCoord] = []
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            tiles.append(TileCoord(level=level.z, tile_x=tx, tile_y=ty))
    return tiles


def _levels_by_z(manifest: Manifest) -> list[LevelInfo]:
    """Levels sorted finest-first (z ascending); validates non-empty & finite scales."""
    if not manifest.levels:
        raise ValueError("manifest has no levels")
    levels = sorted(manifest.levels, key=lambda lvl: lvl.z)
    for lvl in levels:
        s = lvl.pixel_scale_arcsec
        if not (isinstance(s, (int, float)) and math.isfinite(s) and s > 0):
            raise ValueError(
                f"level z={lvl.z} has a non-positive / non-finite pixel_scale_arcsec ({s!r}); "
                "cannot select a level by scale"
            )
    return levels


def select_level_index(
    manifest: Manifest,
    target_scale_arcsec: float,
    *,
    rounding: Rounding = "nearest",
) -> int:
    """Pick the pyramid level (its ``z``) whose pixel scale best serves ``target_scale_arcsec``.

    This is the server-side analogue of the browser's ``targetLevel`` ("idealZoom"):
    the browser chooses the level where one level pixel maps to ~one screen pixel;
    a cutout service chooses the level where one level pixel maps to ~one *output*
    pixel, i.e. whose ``pixel_scale_arcsec`` matches the requested output scale.

    Levels are compared by their manifest-recorded ``pixel_scale_arcsec`` (the
    same numbers the viewer sees), not by assuming an exact 2x-per-level cadence,
    so a level whose block-averaged scale drifts slightly is still ranked
    correctly. The chosen index is clamped to the available levels: a request
    finer than level 0 returns 0, coarser than the deepest returns the deepest.

    ``rounding`` selects the tie-break policy (see :data:`Rounding`). ``"nearest"``
    matches the viewer; ``"finer"`` avoids upsampling (recommended when the
    consumer resamples to an exact output size in numpy anyway).
    """
    if not (target_scale_arcsec > 0):
        raise ValueError(f"target_scale_arcsec must be positive (got {target_scale_arcsec!r})")
    levels = _levels_by_z(manifest)
    scales = [lvl.pixel_scale_arcsec for lvl in levels]

    if rounding == "nearest":
        # Closest in log space == round(-log2(zoom)) in the viewer's formulation.
        best_i = min(range(len(levels)), key=lambda i: abs(math.log2(scales[i] / target_scale_arcsec)))
        return levels[best_i].z
    if rounding == "finer":
        # Coarsest level still at least as fine as the request (scale <= target);
        # fall back to the finest (z=0) when even it is coarser than the request.
        chosen = levels[0]
        for lvl, s in zip(levels, scales):
            if s <= target_scale_arcsec:
                chosen = lvl
        return chosen.z
    if rounding == "coarser":
        # Finest level not finer than the request (scale >= target); fall back to
        # the deepest when even it is finer than the request.
        for lvl, s in zip(levels, scales):
            if s >= target_scale_arcsec:
                return lvl.z
        return levels[-1].z
    raise ValueError(f"unknown rounding {rounding!r}; expected 'nearest', 'finer', or 'coarser'")


def select_level(
    manifest: Manifest,
    target_scale_arcsec: float,
    *,
    rounding: Rounding = "nearest",
) -> LevelInfo:
    """The :class:`~fitsgl.manifest.LevelInfo` chosen by :func:`select_level_index`."""
    z = select_level_index(manifest, target_scale_arcsec, rounding=rounding)
    for lvl in manifest.levels:
        if lvl.z == z:
            return lvl
    # Unreachable: select_level_index only returns a z present in manifest.levels.
    raise AssertionError(f"selected z={z} not found in manifest")
