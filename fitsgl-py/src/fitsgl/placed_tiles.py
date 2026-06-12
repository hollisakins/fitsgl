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
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS

from .build_pyramid import (
    NATIVE_NPY_NAME,
    StopAndAsk,
    _choose_npy_dir,
    _has_distortion,
    _read_input,
)

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


def _tile_geometry(path: Path) -> tuple[WCS, tuple[int, int], fits.Header]:
    """(wcs, (ny, nx), header) for a tile, validated (2D, distortion-free); no data load."""
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
    return wcs, (ny, nx), header


@dataclass
class GridFrame:
    """A shared global grid that several co-gridded bands assemble onto.

    Bands that share a grid ``signature`` (CTYPE/CRVAL/scale) but cover *different
    subsets* of tiles — e.g. F444W over 20 tiles, F410M over 18 of them — are
    placed onto ONE virtual grid of ``shape`` (H, W) whose reference pixel is
    ``ref_crpix``. A band that does not cover the whole frame is NaN-padded up to
    it, so every band ends with the identical native shape + WCS and the bands
    co-grid (compositable in RGB). ``signature`` is the grid each member tile must
    match; ``template_header`` is a member tile's FITS header, used to synthesize
    the frame's global WCS (only CRPIX is moved to the shared reference).
    """

    signature: tuple
    ref_crpix: tuple[float, float]
    shape: tuple[int, int]  # (H, W)
    template_header: fits.Header

    def global_header(self) -> fits.Header:
        """The frame's global WCS header: a member tile's WCS with CRPIX at the
        shared reference (CTYPE/CRVAL/scale are identical across members)."""
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            wcs = WCS(self.template_header).deepcopy()
        wcs.wcs.crpix = [self.ref_crpix[0], self.ref_crpix[1]]
        return wcs.to_header(relax=True)


def _band_footprint(
    geoms: Sequence[tuple[WCS, tuple[int, int], fits.Header]],
) -> tuple[tuple[float, float], tuple[int, int]]:
    """(ref_crpix, (H, W)) for one band's tiles, placed with ref = max CRPIX.

    Mirrors :func:`assemble_placed_tiles`'s own-extent math so a band's standalone
    footprint can be compared against a shared frame's without building anything.
    """
    crpix = [(float(w.wcs.crpix[0]), float(w.wcs.crpix[1])) for (w, _, _) in geoms]
    ref_cx = max(c[0] for c in crpix)
    ref_cy = max(c[1] for c in crpix)
    h = max(round(ref_cy - cy) + ny for (cx, cy), (_, (ny, _nx), _) in zip(crpix, geoms))
    w = max(round(ref_cx - cx) + nx for (cx, cy), (_, (_ny, nx), _) in zip(crpix, geoms))
    return (ref_cx, ref_cy), (h, w)


def plan_grid_frames(
    band_inputs: Sequence[Sequence[str | Path]],
) -> list[GridFrame | None]:
    """The shared :class:`GridFrame` each band should assemble onto, or ``None``.

    Bands are grouped by grid ``signature`` (CTYPE/CRVAL/scale). Within a group of
    ≥2 bands the frame is the UNION of every member tile's footprint (reference =
    component-wise max CRPIX, extent = max placed corner). A band that already
    covers the whole union — the common single-superset case — gets ``None`` so it
    builds byte-identically to the no-frame path; a band covering a strict subset
    gets the frame and is NaN-padded up to it. A solo-signature band gets ``None``.

    Header-only and cheap: tile *data* is never read. Genuinely different grids
    (distinct signatures) stay in separate groups, so a non-cogriddable band is
    never force-padded into the wrong frame — it just builds standalone.
    """
    paths_per_band = [[Path(p) for p in inputs] for inputs in band_inputs]
    geoms_per_band = [[_tile_geometry(p) for p in paths] for paths in paths_per_band]
    # A band's signature for grouping is its first tile's; a band with mixed
    # signatures is left to assemble_placed_tiles to reject (it validates each tile).
    sigs = [_grid_signature(geoms[0][0]) for geoms in geoms_per_band]

    # All tiles' geoms per signature group, to compute the union footprint.
    by_sig: dict[tuple, list[tuple[WCS, tuple[int, int], fits.Header]]] = {}
    members: dict[tuple, int] = {}
    for sig, geoms in zip(sigs, geoms_per_band):
        by_sig.setdefault(sig, []).extend(geoms)
        members[sig] = members.get(sig, 0) + 1

    frames: dict[tuple, GridFrame] = {}
    for sig, all_geoms in by_sig.items():
        ref, shape = _band_footprint(all_geoms)
        frames[sig] = GridFrame(
            signature=sig,
            ref_crpix=ref,
            shape=shape,
            template_header=all_geoms[0][2],
        )

    out: list[GridFrame | None] = []
    for sig, geoms in zip(sigs, geoms_per_band):
        if members[sig] < 2:
            out.append(None)  # nothing to co-grid with → build as-is
            continue
        frame = frames[sig]
        own_ref, own_shape = _band_footprint(geoms)
        matches = (
            abs(own_ref[0] - frame.ref_crpix[0]) <= _PHASE_TOL
            and abs(own_ref[1] - frame.ref_crpix[1]) <= _PHASE_TOL
            and own_shape == frame.shape
        )
        out.append(None if matches else frame)
    return out


def assemble_placed_tiles(
    paths: Sequence[str | Path],
    output_dir: str | Path,
    *,
    frame: GridFrame | None = None,
    on_progress: Callable[[str], None] | None = None,
) -> tuple[fits.Header, tuple[int, int], Path]:
    """Place overlapping input tiles onto one virtual global grid.

    Writes the assembled native array as a ``.npy`` memmap and returns
    ``(global_header, (H, W), native_npy)``, where ``native_npy`` is the actual path
    written (under ``output_dir``, or node-local scratch when it has room — see
    :func:`_choose_npy_dir`). Raises ``StopAndAsk`` if the tiles do not share a grid
    or are sub-pixel-shifted.

    With ``frame`` (a shared :class:`GridFrame`, from :func:`plan_grid_frames`), the
    tiles are placed onto that frame's reference + extent instead of this band's own
    — the band is NaN-padded up to the frame so it co-grids with the other bands in
    its group. Without ``frame`` the band defines its own grid (reference = max
    CRPIX), the original single-band behaviour.
    """
    report = on_progress if on_progress is not None else (lambda _m: None)
    paths = [Path(p) for p in paths]
    if not paths:
        raise ValueError("assemble_placed_tiles: no input tiles")
    report(f"reading {len(paths)} input tiles …")

    geoms = [_tile_geometry(p) for p in paths]  # header-only; one tile loaded at a time later

    if frame is None:
        # SP8 fail-fast: every tile must share projection + reference + scale.
        sig0 = _grid_signature(geoms[0][0])
        for p, (wcs, _shape, _hdr) in zip(paths, geoms):
            if _grid_signature(wcs) != sig0:
                raise StopAndAsk(
                    f"{p}: WCS grid (CTYPE/CRVAL/scale) differs from {paths[0].name}; pre-tiled "
                    "input must share one grid (this pipeline places tiles, it does not reproject)."
                )
        (ref_cx, ref_cy), (H, W) = _band_footprint(geoms)
        # Global WCS = a tile's WCS with CRPIX moved to the shared reference; CTYPE/
        # CRVAL/scale are identical across tiles (verified above).
        global_wcs = geoms[0][0].deepcopy()
        global_wcs.wcs.crpix = [ref_cx, ref_cy]
        global_header = global_wcs.to_header(relax=True)
    else:
        # Shared-frame: every tile must match the frame's grid; the band is padded
        # to the frame's reference + extent (it may cover only a subset of it).
        for p, (wcs, _shape, _hdr) in zip(paths, geoms):
            if _grid_signature(wcs) != frame.signature:
                raise StopAndAsk(
                    f"{p}: WCS grid (CTYPE/CRVAL/scale) differs from the shared grid of its "
                    "co-gridded band group; pre-tiled input must share one grid."
                )
        ref_cx, ref_cy = frame.ref_crpix
        H, W = frame.shape
        global_header = frame.global_header()

    # Integer-phase offsets from CRPIX, relative to the (own or frame) reference.
    offsets: list[tuple[int, int]] = []
    for p, (wcs, (ny, nx), _hdr) in zip(paths, geoms):
        cx, cy = float(wcs.wcs.crpix[0]), float(wcs.wcs.crpix[1])
        ox_f, oy_f = ref_cx - cx, ref_cy - cy
        ox, oy = round(ox_f), round(oy_f)
        if abs(ox_f - ox) > _PHASE_TOL or abs(oy_f - oy) > _PHASE_TOL:
            raise StopAndAsk(
                f"{p}: inter-tile offset ({ox_f:.4f}, {oy_f:.4f}) px is not integer — sub-pixel "
                "phase would need resampling, which this pipeline does not do."
            )
        if ox < 0 or oy < 0 or oy + ny > H or ox + nx > W:
            raise StopAndAsk(
                f"{p}: tile at offset ({ox}, {oy}) size ({nx}, {ny}) falls outside the "
                f"{W}×{H} shared grid — the band group's frame is inconsistent."
            )
        offsets.append((int(ox), int(oy)))

    report(f"assembling {H}×{W} grid from {len(paths)} tiles …")

    # `native` plus the `best` owner-distance buffer below are two full-grid float32
    # arrays; size the scratch decision for both. `_choose_npy_dir` keeps them on the
    # output volume unless scratch provably has room (so a RAM-backed tmpfs can't
    # SIGBUS the `w+` memmap), and colocates `best` with `native` automatically.
    npy_dir = _choose_npy_dir(Path(output_dir), 2 * H * W * 4, report)
    out_npy = npy_dir / NATIVE_NPY_NAME
    native = np.lib.format.open_memmap(out_npy, mode="w+", dtype=np.float32, shape=(H, W))
    native[:] = np.nan
    best_fd, best_path = tempfile.mkstemp(suffix="_bestdist.npy", dir=npy_dir)
    os.close(best_fd)
    try:
        best = np.lib.format.open_memmap(best_path, mode="w+", dtype=np.float32, shape=(H, W))
        best[:] = np.inf
        for p, (ox, oy), (_, (ny, nx), _hdr) in zip(paths, offsets, geoms):
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
    return global_header, (H, W), out_npy
