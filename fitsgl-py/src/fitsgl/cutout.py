"""Plan a server-side cutout from a pyramid: level + covering tiles + supertiles.

This is the top ergonomic layer of the read-side API (issue #17). Given a parsed
:class:`~fitsgl.manifest.Manifest`, a sky position, a field of view, and a desired
output size, :func:`plan_cutout` answers the whole "what do I fetch?" question:

* which pyramid **level** matches the output scale (:mod:`fitsgl.tiles`);
* the **pixel window** of that level covering the requested sky box (projected
  through the level's WCS with astropy — the one step that needs a real WCS
  engine, and the reason this module, unlike :mod:`fitsgl.tiles`, imports astropy);
* which fpack **tiles** cover it, and — via :func:`~fitsgl.tiles.resolve_supertile`
  — which **supertile** ``.fits.fz`` holds each tile with its file-local coords.

The consumer (CAMPFIRE) then range-reads those tiles (see
:mod:`fitsgl.fpack_index` for byte addressing), decodes them with astropy,
assembles the array, crops to :attr:`CutoutPlan.pixel_bbox`, resamples to the
output size, and applies its own stretch/colormap. This module stops at
addressing/geometry — it does not fetch, decode, or resample.

Conventions: sky positions are ICRS degrees; ``fov`` / ``output_size`` are given
as ``(x, y)`` — ``x`` along RA/columns (NAXIS1), ``y`` along Dec/rows (NAXIS2) —
or a scalar for a square. Pixel coordinates are astropy 0-based (pixel center at
the integer), which is exactly the level's data-array indexing.
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass
from typing import Optional, Union

import numpy as np

from .manifest import LevelInfo, Manifest, SupertileInfo
from .tiles import (
    PixelBBox,
    Rounding,
    TileCoord,
    resolve_supertile,
    select_level_index,
    tiles_for_pixel_bbox,
)

#: A size given as a scalar (square) or an explicit ``(x, y)`` pair.
SizeArg = Union[float, tuple[float, float]]


@dataclass(frozen=True)
class TileRef:
    """A covering tile resolved to the supertile file that holds it."""

    tile: TileCoord
    supertile: SupertileInfo
    #: Index of the supertile within its level's ``supertiles`` list.
    supertile_index: int
    #: The tile's coordinates in the supertile's own grid (for :mod:`fitsgl.fpack_index`).
    local_x: int
    local_y: int

    @property
    def filename(self) -> str:
        return self.supertile.filename


@dataclass(frozen=True)
class CutoutPlan:
    """The resolved fetch plan for one cutout request."""

    #: Chosen pyramid level.
    level_index: int
    level: LevelInfo
    #: Output pixel scale (arcsec/pixel) the level was chosen to serve.
    output_scale_arcsec: float
    #: Half-open level-pixel window covering the request, clamped to the level.
    #: Decode the tiles, assemble, then crop to this box before resampling.
    pixel_bbox: PixelBBox
    #: Covering tiles resolved to their supertile files, row-major.
    tiles: list[TileRef]
    #: Covering tiles that fall in a dropped-supertile gap (no data — NaN-fill).
    missing: list[TileCoord]

    def supertile_filenames(self) -> list[str]:
        """Distinct supertile filenames to fetch, in first-seen (row-major) order."""
        seen: dict[str, None] = {}
        for ref in self.tiles:
            seen.setdefault(ref.filename, None)
        return list(seen)

    @property
    def is_empty(self) -> bool:
        """True when the request does not overlap the level's imaged area at all."""
        return not self.tiles and not self.missing


def _as_pair(value: SizeArg, what: str) -> tuple[float, float]:
    if isinstance(value, (int, float)):
        v = float(value)
        pair = (v, v)
    else:
        x, y = value
        pair = (float(x), float(y))
    if not (pair[0] > 0 and pair[1] > 0):
        raise ValueError(f"{what} must be positive (got {value!r})")
    return pair


def _level_wcs(level: LevelInfo):
    """Build an astropy WCS from a level's flat header dict (imported lazily)."""
    from astropy.io import fits
    from astropy.wcs import WCS

    hdr = fits.Header()
    for key, val in level.wcs.items():
        hdr[key] = val
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return WCS(hdr)


def _project_to_pixels(wcs, ra: np.ndarray, dec: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """0-based pixel coords of ICRS ``(ra, dec)`` via the high-level WCS API.

    Uses ``world_to_pixel`` with a ``SkyCoord`` rather than the positional
    ``world_to_pixel_values(ra, dec)`` so the result is correct regardless of the
    header's world-axis order (an axis-swapped ``CTYPE1=DEC``/``CTYPE2=RA`` WCS
    would otherwise feed RA into the Dec axis). The pipeline only emits RA/Dec-TAN,
    so this is defensive, but it is the idiomatic, order-agnostic call.
    """
    from astropy.coordinates import SkyCoord

    coord = SkyCoord(ra=ra, dec=dec, unit="deg", frame="icrs")
    px, py = wcs.world_to_pixel(coord)
    return np.asarray(px, dtype=float), np.asarray(py, dtype=float)


def _sky_box_perimeter(
    center: tuple[float, float], fov_arcsec: tuple[float, float], samples: int
) -> tuple[np.ndarray, np.ndarray]:
    """RA/Dec (deg) samples along the perimeter of the requested sky box.

    The box is centred at ``center`` and aligned to local North/East, ``fov`` wide
    in RA and tall in Dec. Sampling the whole perimeter (not just the 4 corners)
    keeps the projected pixel bounding box a true superset even when the level's
    WCS is rotated or the field is wide enough for TAN curvature to bow the edges.
    """
    ra_c, dec_c = center
    half_w_deg = (fov_arcsec[0] / 2.0) / 3600.0
    half_h_deg = (fov_arcsec[1] / 2.0) / 3600.0
    # RA offsets are along a small circle: divide by cos(dec) so the box spans the
    # requested angular width on the sky. (Cutouts are far from the poles.)
    cos_dec = np.cos(np.radians(dec_c))
    cos_dec = cos_dec if abs(cos_dec) > 1e-9 else 1e-9

    n = max(2, samples)
    t = np.linspace(-1.0, 1.0, n)
    dxs: list[np.ndarray] = []
    dys: list[np.ndarray] = []
    for sy in (-1.0, 1.0):  # bottom & top edges: dx sweeps, dy fixed
        dxs.append(t * half_w_deg)
        dys.append(np.full(n, sy * half_h_deg))
    for sx in (-1.0, 1.0):  # left & right edges: dy sweeps, dx fixed
        dxs.append(np.full(n, sx * half_w_deg))
        dys.append(t * half_h_deg)
    dx = np.concatenate(dxs)
    dy = np.concatenate(dys)
    ra = ra_c + dx / cos_dec
    dec = dec_c + dy
    return ra, dec


def plan_cutout(
    manifest: Manifest,
    center: tuple[float, float],
    fov: SizeArg,
    *,
    output_size: Optional[SizeArg] = None,
    target_scale_arcsec: Optional[float] = None,
    rounding: Rounding = "nearest",
    perimeter_samples: int = 16,
) -> CutoutPlan:
    """Plan a cutout: pick the level and resolve the covering tiles / supertiles.

    Parameters
    ----------
    manifest
        The band's parsed pyramid manifest.
    center
        Cutout centre as ``(ra, dec)`` in ICRS degrees.
    fov
        On-sky field of view in **arcsec**: a scalar (square) or ``(width, height)``
        (width along RA, height along Dec).
    output_size
        Intended output image size in **pixels**: a scalar or ``(width, height)``.
        Together with ``fov`` it sets the output scale (``fov / output_size``) used
        to pick the level. Omit to plan at the finest level (native resolution),
        unless ``target_scale_arcsec`` is given.
    target_scale_arcsec
        Output pixel scale (arcsec/pixel) to select the level by, overriding the
        ``fov / output_size`` computation. Use when the caller already knows the
        scale it wants.
    rounding
        Level tie-break policy (see :data:`fitsgl.tiles.Rounding`). ``"nearest"``
        matches the browser viewer; ``"finer"`` never upsamples.
    perimeter_samples
        Points sampled per box edge when projecting to pixels; more is more robust
        to WCS rotation / wide-field curvature at negligible cost.

    Returns
    -------
    CutoutPlan
        The chosen level, the clamped pixel window, and the covering tiles resolved
        to supertile files. An out-of-field request yields a plan with empty
        ``tiles`` (``plan.is_empty``).
    """
    fov_pair = _as_pair(fov, "fov")

    if target_scale_arcsec is not None:
        if not (target_scale_arcsec > 0):
            raise ValueError(f"target_scale_arcsec must be positive (got {target_scale_arcsec!r})")
        scale = float(target_scale_arcsec)
    elif output_size is not None:
        out = _as_pair(output_size, "output_size")
        scale = 0.5 * (fov_pair[0] / out[0] + fov_pair[1] / out[1])
    else:
        # No scale hint: serve at the finest level (native resolution).
        scale = min(lvl.pixel_scale_arcsec for lvl in manifest.levels)

    # The tile grid is defined at the manifest's fpack tile size — the value the
    # levels were tiled at, in which every fpack_tile_count / supertile origin is
    # expressed. Reading it (not assuming 256) keeps a non-256 dataset correct.
    tile_size = manifest.fpack_tile_size

    level_index = select_level_index(manifest, scale, rounding=rounding)
    level = next(lvl for lvl in manifest.levels if lvl.z == level_index)

    # Project the sky box to the level's pixel grid and take the covering window.
    wcs = _level_wcs(level)
    ra, dec = _sky_box_perimeter(center, fov_pair, perimeter_samples)
    px, py = _project_to_pixels(wcs, ra, dec)
    finite = np.isfinite(px) & np.isfinite(py)
    h, w = int(level.shape[0]), int(level.shape[1])
    if not np.any(finite):
        empty = PixelBBox(0, 0, 0, 0)
        return CutoutPlan(level_index, level, scale, empty, [], [])
    px, py = px[finite], py[finite]

    # 0-based pixel coordinate p sits at the centre of array index floor(p + 0.5);
    # cover from the pixel holding the min extent through the one holding the max.
    col0 = int(np.floor(px.min() + 0.5))
    col1 = int(np.floor(px.max() + 0.5))
    row0 = int(np.floor(py.min() + 0.5))
    row1 = int(np.floor(py.max() + 0.5))
    bbox = PixelBBox(
        x0=max(0, col0),
        y0=max(0, row0),
        x1=min(w, col1 + 1),
        y1=min(h, row1 + 1),
    )

    tiles: list[TileRef] = []
    missing: list[TileCoord] = []
    for coord in tiles_for_pixel_bbox(level, bbox, tile_size=tile_size):
        match = resolve_supertile(level, coord.tile_x, coord.tile_y)
        if match is None:
            missing.append(coord)
        else:
            tiles.append(
                TileRef(
                    tile=coord,
                    supertile=match.supertile,
                    supertile_index=match.index,
                    local_x=match.local_x,
                    local_y=match.local_y,
                )
            )

    return CutoutPlan(
        level_index=level_index,
        level=level,
        output_scale_arcsec=scale,
        pixel_bbox=bbox,
        tiles=tiles,
        missing=missing,
    )
