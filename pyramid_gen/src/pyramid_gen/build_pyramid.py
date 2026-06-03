"""Main pyramid-building pipeline.

Converts a single FITS mosaic into an N+1 level pyramid of independently
fpacked FITS files (astropy ``CompImageHDU``), one file per resolution level.

Every level is a **display-only** product: RICE_1, ``quantize_level=8``,
``SUBTRACTIVE_DITHER_2``. This is lossy but scientifically negligible -- q=8
preserves source photometry to ~0.03% on real (noise-dominated) data, and the
dither seed is stored per level (ZDITHER0) so the browser can reverse it. The
raw, lossless science mosaic is distributed separately, not by this pipeline.

Every level shares a 256x256 fpack-internal tile size. Each file is written and
then read back to verify the pixels round-trip within the quantization tolerance
(and the NaN mask exactly); a failed round-trip raises rather than emitting
broken output.
"""

from __future__ import annotations

import math
import os
import warnings
from collections.abc import Callable
from dataclasses import dataclass
from multiprocessing import Pool
from pathlib import Path

import numpy as np
from astropy.io import fits
from astropy.nddata import block_reduce
from astropy.wcs import WCS
from astropy.wcs.utils import proj_plane_pixel_scales

from .manifest import LevelInfo, Manifest, write_manifest

#: fpack-internal tile size; the unit of HTTP byte ranges the browser requests.
FPACK_TILE_SIZE = 256

#: Lossy quantization level applied to every RICE_1 level. q=8 preserves source
#: photometry to ~0.03% on real (noise-dominated) data while compressing ~5-6x;
#: the pyramid is display-only, so this is scientifically negligible.
DEFAULT_QUANTIZE_LEVEL = 8

#: astropy/CFITSIO quantize_method for SUBTRACTIVE_DITHER_2. Dithering removes the
#: quantization contour-banding on smooth regions; method 2 (vs 1) additionally
#: stores exact-zero pixels losslessly. The browser decoder reverses the dither
#: from the per-level ZDITHER0 seed.
SUBTRACTIVE_DITHER_2 = 2

#: dither_seed sentinel: derive a per-image seed from the data checksum. This is
#: deterministic (reproducible builds) and distinct per level/filter, as the FITS
#: tiled-compression convention recommends.
DITHER_SEED_CHECKSUM = -1


class StopAndAsk(Exception):
    """Raised for inputs the spec says to stop and ask a human about.

    Covers multiple ambiguous image HDUs, non-2D data, and SIP/TPV distortion
    polynomials -- cases where silently guessing would risk a wrong science
    product.
    """


# --------------------------------------------------------------------------- #
# Geometry helpers
# --------------------------------------------------------------------------- #
def n_levels(shape: tuple[int, int], tile_size: int = FPACK_TILE_SIZE) -> int:
    """Number of downsampled levels N (so the pyramid has N+1 levels, z=0..N).

    N = ceil(log2(max(image_dims) / tile_size)), clamped at 0 so an image that
    already fits within a single tile produces just z=0.
    """
    maxdim = max(shape)
    if maxdim <= tile_size:
        return 0
    return int(math.ceil(math.log2(maxdim / tile_size)))


def _downsample(data: np.ndarray, factor: int) -> np.ndarray:
    """Block-average by an integer factor, ignoring NaNs.

    ``block_reduce`` trims any non-divisible remainder from the end of each
    axis, which keeps the corner-origin WCS valid. Fully-NaN blocks reduce to
    NaN (the expected RuntimeWarning is suppressed).
    """
    if factor == 1:
        # Copy (not asarray) so the z=0 level is a writable array independent of a
        # read-only memmap input.
        return np.array(data, dtype=np.float32)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", category=RuntimeWarning)
        reduced = block_reduce(data, factor, func=np.nanmean)
    return reduced.astype(np.float32)


def _scale_wcs(wcs: WCS, factor: int) -> WCS:
    """Scale a WCS for an image downsampled by ``factor``.

    The pixel-scale matrix (CD if present, else CDELT) is multiplied by
    ``factor``. CRPIX uses the exact block-average mapping

        CRPIX_new = CRPIX_old / factor + (factor - 1) / (2 * factor)

    rather than the naive ``CRPIX_old / factor``. The naive form leaves a
    half-pixel astrometric offset (~0.06" for a 4x downsample at 0.03"/px); the
    correction makes the center of downsampled pixel (0,0) land exactly on the
    center of the native block it averages.
    """
    w = wcs.deepcopy()
    if wcs.wcs.has_cd():
        w.wcs.cd = wcs.wcs.cd * factor
    else:
        w.wcs.cdelt = wcs.wcs.cdelt * factor
    w.wcs.crpix = wcs.wcs.crpix / factor + (factor - 1) / (2.0 * factor)
    return w


def _pixel_scale_arcsec(wcs: WCS) -> float:
    """Mean pixel scale in arcsec/pixel from the WCS."""
    scales = proj_plane_pixel_scales(wcs)  # degrees/pixel per axis
    return float(np.mean(scales) * 3600.0)


def _tile_count(shape: tuple[int, int], tile_size: int) -> list[int]:
    """[n_tiles_y, n_tiles_x] for a given image shape and tile size."""
    h, w = shape
    return [math.ceil(h / tile_size), math.ceil(w / tile_size)]


# --------------------------------------------------------------------------- #
# Round-trip verification
# --------------------------------------------------------------------------- #
def estimate_noise(data: np.ndarray) -> float:
    """Robust noise estimate (MAD-scaled) over finite pixels.

    Used both to set the q>0 round-trip tolerance and by tests. MAD is robust
    to the bright sources that would inflate a plain standard deviation.
    """
    finite = data[np.isfinite(data)]
    if finite.size == 0:
        return 0.0
    med = np.median(finite)
    mad = np.median(np.abs(finite - med))
    return float(1.4826 * mad)


def quant_atol(data: np.ndarray) -> float:
    """Absolute tolerance for a q=8 RICE round-trip.

    The quantization step is ~noise_sigma/8, so the per-pixel error (including the
    subtractive-dither residual) stays well under noise_sigma. We use one
    noise_sigma as a safe upper bound that still flags gross corruption (which
    would be many sigma). A small floor handles degenerate noiseless inputs.
    """
    sigma = estimate_noise(data)
    return max(sigma, 1e-6)


def _verify_roundtrip(original: np.ndarray, readback: np.ndarray, z: int) -> None:
    """Verify a written level reads back correctly; raise if not.

    Every level is lossy RICE_1 q=8 (display-only). The NaN mask must round-trip
    exactly (no finite<->NaN leakage), and finite pixels must match within the
    quantization tolerance (~one noise sigma; the q=8 step is ~sigma/8).
    """
    if not np.array_equal(np.isnan(original), np.isnan(readback)):
        raise RuntimeError(
            f"z={z}: NaN mask changed on round-trip (NaN handling broken)"
        )
    finite = np.isfinite(original)
    atol = quant_atol(original)
    if not np.allclose(original[finite], readback[finite], rtol=0.0, atol=atol):
        max_err = float(np.max(np.abs(original[finite] - readback[finite])))
        raise RuntimeError(
            f"z={z}: lossy round-trip exceeded tolerance "
            f"(max_err={max_err:.6g} > atol={atol:.6g})"
        )


# --------------------------------------------------------------------------- #
# Input reading / validation
# --------------------------------------------------------------------------- #
def _has_distortion(header: fits.Header, wcs: WCS) -> bool:
    """Detect SIP or TPV distortion polynomials in the WCS."""
    if wcs.sip is not None:
        return True
    for key in ("CTYPE1", "CTYPE2"):
        val = str(header.get(key, ""))
        if "-SIP" in val or "-TPV" in val:
            return True
    # TPV / distortion-paper coefficients.
    if wcs.cpdis1 is not None or wcs.cpdis2 is not None:
        return True
    return False


def _read_input(input_path: Path) -> tuple[np.ndarray, fits.Header]:
    """Read and validate the input mosaic, returning (data, header).

    Raises StopAndAsk for the ambiguous cases the spec defers to a human:
    multiple image HDUs, non-2D data, or SIP/TPV distortion.
    """
    with fits.open(input_path) as hdul:
        image_hdus = [
            i
            for i, hdu in enumerate(hdul)
            if getattr(hdu, "data", None) is not None and hdu.data.ndim >= 2
        ]
        if not image_hdus:
            raise StopAndAsk(f"{input_path}: no image data found in any HDU")
        # Count genuinely-2D image HDUs to detect ambiguity.
        two_d = [i for i in image_hdus if hdul[i].data.ndim == 2]
        if len(two_d) > 1:
            raise StopAndAsk(
                f"{input_path}: multiple 2D image HDUs {two_d}; unclear which to "
                "tile -- stop and ask which HDU is the science mosaic"
            )
        idx = two_d[0] if two_d else image_hdus[0]
        data = np.asarray(hdul[idx].data)
        header = hdul[idx].header.copy()

    if data.ndim != 2:
        raise StopAndAsk(
            f"{input_path}: image HDU is {data.ndim}-D; only 2D mosaics are "
            "supported -- stop and ask how to reduce it to 2D"
        )

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        wcs = WCS(header)
    if _has_distortion(header, wcs):
        raise StopAndAsk(
            f"{input_path}: WCS contains SIP/TPV distortion polynomials, which "
            "this pipeline does not yet rescale -- stop and ask how to handle "
            "distortion under downsampling"
        )

    # CompImageHDU works in native float; ensure a float dtype for downsampling
    # and NaN handling.
    if not np.issubdtype(data.dtype, np.floating):
        data = data.astype(np.float32)
    return data, header


# --------------------------------------------------------------------------- #
# Per-level worker (module-level so it is picklable for multiprocessing)
# --------------------------------------------------------------------------- #
@dataclass
class _LevelTask:
    z: int
    factor: int
    out_path: str
    filename: str
    tile_size: int
    quantize_level: int
    native_npy: str  # path to a .npy of the native array; workers mmap it (shared)
    header: fits.Header


def _check_descriptor_overflow(bintable_header: fits.Header, z: int) -> None:
    """Guard against the silent 32-bit heap-offset overflow.

    astropy picks the COMPRESSED_DATA descriptor format from the *uncompressed*
    size (>4 GiB -> 64-bit 'Q', else 32-bit 'P'), but the real limit is the
    *compressed* heap fitting a 32-bit offset (<2 GiB). They diverge only when the
    compression ratio is below 2x, which RICE q=8 on real data never is -- but
    rather than trust that, refuse to emit a file whose 'P'-format heap (PCOUNT)
    has overflowed 2 GiB (numpy's offset cumsum would wrap silently, corrupting
    every tile past the 2 GiB mark).
    """
    tfields = int(bintable_header.get("TFIELDS", 0))
    tforms = [str(bintable_header.get(f"TFORM{i}", "")) for i in range(1, tfields + 1)]
    uses_p_descriptor = any("P" in tf and "Q" not in tf for tf in tforms)
    pcount = int(bintable_header.get("PCOUNT", 0))
    if uses_p_descriptor and pcount >= 2**31:
        raise RuntimeError(
            f"z={z}: compressed heap is {pcount} bytes (>2 GiB) but the file uses "
            f"32-bit 'P' heap descriptors, whose offsets would overflow silently. "
            f"astropy auto-selects 64-bit 'Q' only when the uncompressed image "
            f"exceeds 4 GiB."
        )


def _build_level(task: _LevelTask) -> dict:
    """Build, write, and verify a single pyramid level. Returns a LevelInfo dict.

    Every level is a display-only RICE_1 + SUBTRACTIVE_DITHER_2 tile set (q=8);
    there is no lossless level (the raw mosaic is distributed separately).

    The native array is read via a read-only memory-map of the shared ``.npy``
    (``native_npy``), so every level worker shares one copy through the OS page
    cache rather than receiving a pickled copy of the full mosaic.
    """
    native = np.load(task.native_npy, mmap_mode="r")

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        native_wcs = WCS(task.header)

    level = _downsample(native, task.factor)
    level_wcs = _scale_wcs(native_wcs, task.factor)
    level_header = level_wcs.to_header(relax=True)

    hdu = fits.CompImageHDU(
        data=level,
        header=level_header,
        compression_type="RICE_1",
        tile_shape=(task.tile_size, task.tile_size),
        quantize_level=task.quantize_level,
        quantize_method=SUBTRACTIVE_DITHER_2,
        dither_seed=DITHER_SEED_CHECKSUM,
    )
    fits.HDUList([fits.PrimaryHDU(), hdu]).writeto(task.out_path, overwrite=True)

    # Read back and verify before declaring the level good.
    with fits.open(task.out_path) as hdul:
        readback = np.asarray(hdul[1].data)
    _verify_roundtrip(level, readback, task.z)

    # Read the ACTUAL compression keyword so the manifest hint can never drift
    # from the file. ZCMPTYPE lives in the compressed bintable header; while it's
    # open, assert the heap descriptors did not silently overflow.
    with fits.open(task.out_path, disable_image_compression=True) as hdul:
        bintable_header = hdul[1].header
        zcmptype = str(bintable_header["ZCMPTYPE"])
        _check_descriptor_overflow(bintable_header, task.z)

    level_info = LevelInfo(
        z=task.z,
        filename=task.filename,
        compression=zcmptype,
        lossless=False,
        shape=[int(level.shape[0]), int(level.shape[1])],
        fpack_tile_count=_tile_count(level.shape, task.tile_size),
        pixel_scale_arcsec=_pixel_scale_arcsec(level_wcs),
        wcs={k: level_header[k] for k in level_header},
    )
    return level_info.to_dict()


# --------------------------------------------------------------------------- #
# Orchestration
# --------------------------------------------------------------------------- #
def build_pyramid(
    input_path: str | Path,
    output_dir: str | Path | None = None,
    *,
    tile_size: int = FPACK_TILE_SIZE,
    quantize_level: int = DEFAULT_QUANTIZE_LEVEL,
    processes: int | None = None,
    on_progress: Callable[[str], None] | None = None,
) -> Manifest:
    """Build a multi-resolution fpacked pyramid from one FITS mosaic.

    Parameters
    ----------
    input_path
        Path to the source FITS mosaic.
    output_dir
        Output directory. Defaults to ``<input_stem>_pyramid/`` beside the input.
    tile_size
        fpack-internal tile size (default 256).
    quantize_level
        RICE_1 quantization level applied to every level (default 8).
    processes
        Worker process count. Defaults to one per level (capped at cpu count).
    on_progress
        Optional callback invoked with human-readable progress lines (input read,
        levels building, each level as it completes). Defaults to silent.

    Returns
    -------
    Manifest
        The written manifest, also serialized to ``output_dir/manifest.json``.
    """
    input_path = Path(input_path)
    report = on_progress if on_progress is not None else (lambda _msg: None)
    report(f"reading {input_path.name} …")
    data, header = _read_input(input_path)
    native_h, native_w = int(data.shape[0]), int(data.shape[1])
    report(f"read {native_h}×{native_w} mosaic")

    stem = input_path.stem
    if output_dir is None:
        output_dir = input_path.parent / f"{stem}_pyramid"
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    N = n_levels((native_h, native_w), tile_size)

    # Stage the native array as a .npy that every level worker memory-maps
    # (read-only) instead of receiving a pickled copy. Under the 'spawn' start
    # method, pickling the full mosaic per level is O(levels × mosaic) of IPC +
    # peak memory and is what makes a large build thrash; the page-cache-backed
    # mmap shares ONE copy. Freed from the parent here, then unlinked when done.
    native_npy = output_dir / "_native.npy"
    np.save(native_npy, data)
    del data

    try:
        tasks = [
            _LevelTask(
                z=z,
                factor=2**z,
                out_path=str(output_dir / f"{stem}_z{z}.fits.fz"),
                filename=f"{stem}_z{z}.fits.fz",
                tile_size=tile_size,
                quantize_level=quantize_level,
                native_npy=str(native_npy),
                header=header,
            )
            for z in range(N + 1)
        ]

        # One process per level -- CompImageHDU writing is not thread-safe within a
        # level, and levels are fully independent, so process-per-level is the clean
        # parallel unit. Single level -> run inline to avoid Pool overhead.
        if len(tasks) == 1:
            report("building 1 level (z=0) …")
            level_dicts = [_build_level(tasks[0])]
            report(f"  z0 done — {level_dicts[0]['shape'][0]}×{level_dicts[0]['shape'][1]}")
        else:
            n_proc = processes or min(len(tasks), os.cpu_count() or 1)
            report(f"building {len(tasks)} levels (z=0..{N}) on {n_proc} worker(s) …")
            # imap_unordered so each level reports as it finishes (the largest, z=0,
            # is last); results are collected then sorted by z below, so order holds.
            level_dicts = []
            with Pool(processes=n_proc) as pool:
                for d in pool.imap_unordered(_build_level, tasks):
                    level_dicts.append(d)
                    report(
                        f"  z{d['z']} done — {d['shape'][0]}×{d['shape'][1]} "
                        f"({len(level_dicts)}/{len(tasks)})"
                    )

        levels = [LevelInfo.from_dict(d) for d in level_dicts]
        levels.sort(key=lambda lvl: lvl.z)

        manifest = Manifest(
            source_file=input_path.name,
            native_shape=[native_h, native_w],
            fpack_tile_size=tile_size,
            n_levels=N,
            levels=levels,
        )
        write_manifest(output_dir / "manifest.json", manifest)
    finally:
        native_npy.unlink(missing_ok=True)
    return manifest
