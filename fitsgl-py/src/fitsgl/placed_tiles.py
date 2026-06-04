"""Assemble a pre-tiled input mosaic into one virtual native grid (no resampling).

Reads N overlapping input tiles that share a projection (``CTYPE``), reference
world point (``CRVAL``), and scale matrix (``CD`` or ``CDELT``+``PC``), differing
only by an **integer** pixel offset (``CRPIX``). It places them onto one virtual
global pixel grid and resolves overlaps by *nearest tile center* (the interior tile
wins, so the seam falls on the midline and a tile's noisy edge loses to its
neighbour's interior). The assembled native array is written as a ``.npy`` memmap
for the existing pyramid builder, so a pre-tiled dataset flows through the exact
same supertile/manifest path as a single-FITS one.

WCS reprojection is explicitly out of scope (roadmap D1): tiles whose grids differ
(``CTYPE``/``CRVAL``/scale) or whose phase is sub-pixel are rejected (``StopAndAsk``).
Ensuring the producer's tiles share a grid is the producer's responsibility; this
module only refuses to silently mis-assemble mismatched input.
"""

from __future__ import annotations

import os
import tempfile
import warnings
from collections.abc import Callable, Sequence
from pathlib import Path

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS

from .build_pyramid import StopAndAsk, _has_distortion, _read_input

#: Max |fractional pixel| an inter-tile offset may have and still count as integer
#: phase. Above this, tiles are sub-pixel-shifted and would need resampling.
_PHASE_TOL = 1e-3


def _scale_matrix(wcs: WCS) -> np.ndarray:
    """The effective pixel→world linear matrix (CD, or diag(CDELT)·PC), so a tile
    using CD and one using CDELT+PC compare equal when they describe the same grid."""
    w = wcs.wcs
    if w.has_cd():
        return np.asarray(w.cd, dtype=float)
    return np.diag(np.asarray(w.cdelt, dtype=float)) @ np.asarray(w.get_pc(), dtype=float)


def _grid_signature(wcs: WCS) -> tuple:
    """Hashable signature of the WCS parts that must match across tiles: projection
    (``CTYPE``), reference world point (``CRVAL``), and scale matrix. ``CRPIX`` is
    excluded — it is the only thing allowed to differ (the per-tile offset)."""
    w = wcs.wcs
    ctype = tuple(str(c) for c in w.ctype)
    crval = tuple(round(float(v), 9) for v in w.crval)
    scale = tuple(round(float(v), 15) for v in _scale_matrix(wcs).ravel())
    return (ctype, crval, scale)


def _tile_geometry(path: Path) -> tuple[WCS, tuple[int, int]]:
    """(wcs, (ny, nx)) for a tile, validated (2D, distortion-free); no data load."""
    with fits.open(path) as hdul:
        idx = next((i for i, h in enumerate(hdul) if int(h.header.get("NAXIS", 0)) >= 2), None)
        if idx is None:
            raise StopAndAsk(f"{path}: no 2D image HDU found")
        header = hdul[idx].header.copy()
    if int(header.get("NAXIS", 0)) != 2:
        raise StopAndAsk(f"{path}: image HDU is {header.get('NAXIS')}-D; only 2D tiles supported")
    ny, nx = int(header["NAXIS2"]), int(header["NAXIS1"])
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        wcs = WCS(header)
    if _has_distortion(header, wcs):
        raise StopAndAsk(
            f"{path}: WCS has SIP/TPV distortion; pre-tiled assembly needs distortion-free tiles"
        )
    return wcs, (ny, nx)


def assemble_placed_tiles(
    paths: Sequence[str | Path],
    out_npy: str | Path,
    *,
    on_progress: Callable[[str], None] | None = None,
) -> tuple[fits.Header, tuple[int, int]]:
    """Place overlapping input tiles onto one virtual global grid.

    Writes the assembled native array to ``out_npy`` (a ``.npy`` memmap) and returns
    ``(global_header, (H, W))``. Raises ``StopAndAsk`` if the tiles do not share a
    grid or are sub-pixel-shifted.
    """
    report = on_progress if on_progress is not None else (lambda _m: None)
    paths = [Path(p) for p in paths]
    if not paths:
        raise ValueError("assemble_placed_tiles: no input tiles")
    report(f"reading {len(paths)} input tiles …")

    geoms = [_tile_geometry(p) for p in paths]  # header-only; one tile loaded at a time later

    # SP8 fail-fast: every tile must share projection + reference + scale.
    sig0 = _grid_signature(geoms[0][0])
    for p, (wcs, _) in zip(paths, geoms):
        if _grid_signature(wcs) != sig0:
            raise StopAndAsk(
                f"{p}: WCS grid (CTYPE/CRVAL/scale) differs from {paths[0].name}; pre-tiled "
                "input must share one grid (this pipeline places tiles, it does not reproject)."
            )

    # Integer-phase offsets from CRPIX; global origin chosen so all offsets are >= 0.
    crpix = [(float(wcs.wcs.crpix[0]), float(wcs.wcs.crpix[1])) for (wcs, _) in geoms]
    max_cx = max(c[0] for c in crpix)
    max_cy = max(c[1] for c in crpix)
    offsets: list[tuple[int, int]] = []
    for p, (cx, cy) in zip(paths, crpix):
        ox_f, oy_f = max_cx - cx, max_cy - cy
        ox, oy = round(ox_f), round(oy_f)
        if abs(ox_f - ox) > _PHASE_TOL or abs(oy_f - oy) > _PHASE_TOL:
            raise StopAndAsk(
                f"{p}: inter-tile offset ({ox_f:.4f}, {oy_f:.4f}) px is not integer — sub-pixel "
                "phase would need resampling, which this pipeline does not do."
            )
        offsets.append((int(ox), int(oy)))

    H = max(oy + ny for (_, oy), (_, (ny, _nx)) in zip(offsets, geoms))
    W = max(ox + nx for (ox, _), (_, (_ny, nx)) in zip(offsets, geoms))
    report(f"assembling {H}×{W} grid from {len(paths)} tiles …")

    # Global WCS = a tile's WCS with CRPIX moved to the shared reference (max_cx, max_cy);
    # CTYPE/CRVAL/scale are identical across tiles (verified above).
    global_wcs = geoms[0][0].deepcopy()
    global_wcs.wcs.crpix = [max_cx, max_cy]
    global_header = global_wcs.to_header(relax=True)

    native = np.lib.format.open_memmap(out_npy, mode="w+", dtype=np.float32, shape=(H, W))
    native[:] = np.nan
    # `best` (owner squared-distance) is the only extra full-grid buffer; memmap it so
    # peak RAM stays ~one tile rather than another full mosaic.
    best_fd, best_path = tempfile.mkstemp(suffix="_bestdist.npy")
    os.close(best_fd)
    try:
        best = np.lib.format.open_memmap(best_path, mode="w+", dtype=np.float32, shape=(H, W))
        best[:] = np.inf
        for p, (ox, oy), (_, (ny, nx)) in zip(paths, offsets, geoms):
            data, _ = _read_input(p)  # validated float data, one tile at a time
            data = np.asarray(data, dtype=np.float32)
            if data.shape != (ny, nx):
                raise StopAndAsk(f"{p}: data shape {data.shape} != header {(ny, nx)}")
            gcx = ox + (nx - 1) / 2.0
            gcy = oy + (ny - 1) / 2.0
            dx = (np.arange(nx, dtype=np.float32) + (ox - gcx))[None, :]
            dy = (np.arange(ny, dtype=np.float32) + (oy - gcy))[:, None]
            dist = dy * dy + dx * dx  # squared distance to this tile's center
            sub_native = native[oy : oy + ny, ox : ox + nx]
            sub_best = best[oy : oy + ny, ox : ox + nx]
            win = dist < sub_best  # strictly nearer center wins; earlier tile breaks ties
            sub_native[win] = data[win]
            sub_best[win] = dist[win]
        del best
    finally:
        Path(best_path).unlink(missing_ok=True)
    del native  # flush the assembled grid to disk
    return global_header, (H, W)
