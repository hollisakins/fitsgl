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
import shutil
import tempfile
import warnings
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from multiprocessing import Pool
from pathlib import Path
from typing import TYPE_CHECKING

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS
from astropy.wcs.utils import proj_plane_pixel_scales

from .manifest import LevelInfo, Manifest, SupertileInfo, write_manifest

if TYPE_CHECKING:
    from .placed_tiles import GridFrame

#: fpack-internal tile size; the unit of HTTP byte ranges the browser requests.
FPACK_TILE_SIZE = 256

#: A level is partitioned into supertiles of at most this many render-tiles per side
#: (a standalone ``.fits.fz`` each). Chosen so even worst-case (lossless-fallback,
#: ~160 KB/tile) supertiles stay under the 512 MB CDN edge-cache limit; on real
#: noise-dominated data (~47 KB/tile) files are ~100 MB. Tunable; to be locked
#: empirically against real COSMOS-Web tiles.
DEFAULT_SUPERTILE_BLOCKS = 48

#: Hard ceiling per emitted ``.fits.fz``: Cloudflare's max cacheable object size on
#: Free/Pro/Business plans. A supertile over this is a build error (reduce the block
#: size) rather than a silently-uncacheable file.
EDGE_CACHE_LIMIT_BYTES = 512 * 1024 * 1024

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

#: Basename of the transient native array every level worker memory-maps.
NATIVE_NPY_NAME = "_native.npy"

#: Require this much more free space than the array needs before staging it in
#: scratch -- leaves headroom for the ``.npy`` header and filesystem slack, and
#: (the real reason) keeps a RAM-backed tmpfs off its hard edge, where a ``w+``
#: memmap page-fault would SIGBUS rather than raise.
_SCRATCH_HEADROOM = 1.1


def _scratch_dir() -> Path | None:
    """Opt-in node-local scratch for the transient native/bestdist memmaps.

    Honours ``$FITSGL_SCRATCH`` first, then ``$TMPDIR``. Returns ``None`` when
    neither names an existing directory, which keeps the original behaviour of
    colocating the transient with the (possibly networked) output volume.
    """
    for var in ("FITSGL_SCRATCH", "TMPDIR"):
        val = os.environ.get(var)
        if val and os.path.isdir(val):
            return Path(val)
    return None


def _choose_npy_dir(
    output_dir: Path, est_bytes: int, report: Callable[[str], None]
) -> Path:
    """Pick where the transient native array (and, when pre-tiling, bestdist) live.

    Prefer node-local scratch (``$FITSGL_SCRATCH``/``$TMPDIR``) when it has
    comfortably more free space than the array needs. On a networked output volume
    the level workers' strided, read-only ``mmap`` of this file is the build's
    dominant I/O cost, and it is far cheaper from local disk; the file is unlinked
    at the end, so nothing extra is ever copied to the slow output volume.

    The free-space check is also what makes scratch *safe* on a RAM-backed tmpfs --
    if the pages provably fit, the ``w+`` memmap cannot SIGBUS -- which is why the
    builder historically pinned these arrays to the output volume. When scratch is
    unset, resolves to the output volume, or is too small, fall back to the output
    dir, so this never turns a build that used to pass into one that fails.

    Returns a freshly-created, unique scratch subdirectory (so concurrent builds
    sharing one ``$TMPDIR`` never collide on the fixed ``_native.npy`` name); the
    caller is responsible for removing it. Returns ``output_dir`` unchanged on
    fallback.
    """
    scratch = _scratch_dir()
    if scratch is None:
        return output_dir
    try:
        if scratch.resolve() == output_dir.resolve():
            return output_dir
        free = shutil.disk_usage(scratch).free
    except OSError:
        return output_dir
    needed = int(est_bytes * _SCRATCH_HEADROOM)
    if free < needed:
        report(
            f"scratch {scratch} has only {free // (1 << 20)} MiB free for a "
            f"~{needed // (1 << 20)} MiB native array — keeping it on the output volume"
        )
        return output_dir
    try:
        staged = Path(tempfile.mkdtemp(prefix="fitsgl-native-", dir=scratch))
    except OSError:
        return output_dir
    report(f"staging native array in scratch {staged} ({free // (1 << 20)} MiB free)")
    return staged


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


#: Target pixels per native row-strip when block-averaging a level. ``np.nanmean``
#: copies its input (``_replace_nan``), so reducing a whole multi-GB level at once
#: allocates ~2× the array — the dominant peak that OOMs a large mosaic (a single
#: COSMOS-scale level's nanmean copy is ~30 GiB, ×N parallel level workers). Reducing
#: in factor-aligned strips bounds that transient to ~this many float32 px (~256 MB)
#: per worker, regardless of mosaic size, with a bit-identical result.
_DOWNSAMPLE_STRIP_PIXELS = 64_000_000


def _downsample(data: np.ndarray, factor: int) -> np.ndarray:
    """Block-average by an integer factor, ignoring NaNs.

    Trims any non-divisible remainder from the end of each axis (keeping the
    corner-origin WCS valid) and reduces fully-NaN blocks to NaN — identical to
    ``block_reduce(data, factor, func=np.nanmean)``, but computed in factor-aligned
    row-strips so a multi-GB level never materializes a full-image ``np.nanmean``
    copy (the allocation that OOMs a large mosaic). Each output pixel's block lies
    wholly within one strip, so the strided result is bit-identical to reducing the
    whole array at once. The expected all-NaN-block RuntimeWarning is suppressed.
    """
    if factor == 1:
        # No copy: pass the (copy-on-write memmap) native array straight through.
        # Nothing downstream mutates it, and avoiding a full copy matters at z=0,
        # where the array can be many GB.
        return np.asarray(data, dtype=np.float32)
    h, w = data.shape
    out_h, out_w = h // factor, w // factor  # trim the non-divisible remainder
    out = np.empty((out_h, out_w), dtype=np.float32)
    if out_h == 0 or out_w == 0:
        return out
    cols = out_w * factor  # trimmed native width
    # Output rows per strip, sized so the materialized native strip (rows*factor ×
    # cols) stays near the target pixel budget; at least one output row.
    rows_per_strip = max(1, _DOWNSAMPLE_STRIP_PIXELS // (factor * cols))
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", category=RuntimeWarning)  # all-NaN block -> NaN
        for r0 in range(0, out_h, rows_per_strip):
            r1 = min(r0 + rows_per_strip, out_h)
            strip = np.asarray(data[r0 * factor : r1 * factor, :cols], dtype=np.float32)
            blocks = strip.reshape(r1 - r0, factor, out_w, factor)
            out[r0:r1] = np.nanmean(blocks, axis=(1, 3))
    return out


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


def _common_stem(paths: list[Path]) -> str:
    """A filename stem for the output: the single input's stem, or the common
    prefix of multiple tiles' stems (trailing separators trimmed)."""
    if len(paths) == 1:
        return paths[0].stem
    prefix = os.path.commonprefix([p.stem for p in paths]).rstrip("_-. ")
    return prefix or "mosaic"


def _supertile_blocks(n_tiles_x: int, n_tiles_y: int, k: int) -> list[tuple[int, int, int, int]]:
    """Partition an ``n_tiles_x × n_tiles_y`` render-tile grid into ``k×k``-tile blocks.

    Returns ``(tx0, ty0, snx, sny)`` rectangles in row-major block order — a disjoint
    cover of the whole grid; edge blocks are smaller. A grid that already fits in one
    block (both dims ≤ k) yields a single ``(0, 0, n_tiles_x, n_tiles_y)`` — the
    degenerate, un-chunked level.
    """
    blocks: list[tuple[int, int, int, int]] = []
    for ty0 in range(0, n_tiles_y, k):
        sny = min(k, n_tiles_y - ty0)
        for tx0 in range(0, n_tiles_x, k):
            snx = min(k, n_tiles_x - tx0)
            blocks.append((tx0, ty0, snx, sny))
    return blocks


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
    subtractive-dither residual) stays well under noise_sigma. We bound at two
    noise_sigma: astropy drives the q=8 step from its own noise estimator, which
    can run hotter than this robust MAD estimate (gradients/sources inflate it),
    so a legitimate worst-case dither residual can sit just over one MAD-sigma.
    2x absorbs that mismatch while still flagging gross corruption (many sigma).
    A small floor handles degenerate noiseless inputs.
    """
    sigma = estimate_noise(data)
    return max(sigma, 1e-6) * 2.0


def _verify_roundtrip(original: np.ndarray, readback: np.ndarray, z: int) -> None:
    """Verify a written level reads back correctly; raise if not.

    Every level is lossy RICE_1 q=8 (display-only). The NaN mask must round-trip
    exactly (no finite<->NaN leakage), and finite pixels must match within the
    quantization tolerance (~one noise sigma; the q=8 step is ~sigma/8).

    Done in row-blocks so a multi-GB level never materializes full-image
    boolean-index temporaries (``original[finite]`` etc.), which would multiply
    peak memory several-fold. The tolerance is estimated from a strided subsample
    of the data — a robust MAD estimate needs only a sample, not every pixel.
    """
    if original.shape != readback.shape:
        raise RuntimeError(f"z={z}: round-trip shape {readback.shape} != {original.shape}")

    flat = np.asarray(original).reshape(-1)
    stride = max(1, flat.size // 1_000_000)
    atol = quant_atol(flat[::stride])

    cols = original.shape[1]
    block = max(1, 8_000_000 // max(1, cols))  # ~8M pixels per row-block
    max_err = 0.0
    for r0 in range(0, original.shape[0], block):
        o = np.asarray(original[r0 : r0 + block], dtype=np.float32)
        b = np.asarray(readback[r0 : r0 + block], dtype=np.float32)
        o_nan = np.isnan(o)
        if not np.array_equal(o_nan, np.isnan(b)):
            raise RuntimeError(f"z={z}: NaN mask changed on round-trip (NaN handling broken)")
        finite = ~o_nan
        if finite.any():
            err = np.abs(o[finite] - b[finite])
            if err.size:
                max_err = max(max_err, float(err.max()))
    if max_err > atol:
        raise RuntimeError(
            f"z={z}: lossy round-trip exceeded tolerance (max_err={max_err:.6g} > atol={atol:.6g})"
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
    out_dir: str  # the band's output directory; the worker names its supertile files
    stem: str  # input stem, for the supertile filenames
    tile_size: int
    quantize_level: int
    supertile_blocks: int  # max render-tiles per side per supertile (K)
    size_budget: int  # hard per-file ceiling in bytes (EDGE_CACHE_LIMIT_BYTES)
    native_npy: str  # path to a .npy of the native array; workers mmap it (shared)
    header: fits.Header
    verify: bool = True


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


def _write_supertile(
    sub: np.ndarray, header: fits.Header, out_path: str, task: _LevelTask
) -> str:
    """Write one supertile ``.fits.fz``, verify it, and return its actual ZCMPTYPE.

    Same display-only RICE_1 + SUBTRACTIVE_DITHER_2 (q=8) encoding as a whole level;
    a supertile is just a sub-rectangle written as its own self-contained file.
    """
    hdu = fits.CompImageHDU(
        data=sub,
        header=header,
        compression_type="RICE_1",
        tile_shape=(task.tile_size, task.tile_size),
        quantize_level=task.quantize_level,
        quantize_method=SUBTRACTIVE_DITHER_2,
        dither_seed=DITHER_SEED_CHECKSUM,
    )
    fits.HDUList([fits.PrimaryHDU(), hdu]).writeto(out_path, overwrite=True)

    # Read back and verify the lossy round-trip before declaring it good (a second
    # decode of this supertile); skippable (verify=False) when memory is tight.
    if task.verify:
        with fits.open(out_path) as hdul:
            readback = np.asarray(hdul[1].data)
        _verify_roundtrip(sub, readback, task.z)

    # Read the ACTUAL compression keyword so the manifest hint can never drift from
    # the file, and assert the heap descriptors did not silently overflow.
    with fits.open(out_path, disable_image_compression=True) as hdul:
        bintable_header = hdul[1].header
        zcmptype = str(bintable_header["ZCMPTYPE"])
        _check_descriptor_overflow(bintable_header, task.z)
    return zcmptype


def _build_level(task: _LevelTask) -> dict:
    """Build, write, and verify one pyramid level as one or more supertiles.

    The level is partitioned into ``K×K``-render-tile supertiles (``K`` =
    ``task.supertile_blocks``); each is written as a standalone ``.fits.fz`` and its
    placement (origin + tile count) recorded. A level that fits in one block is the
    common, un-chunked case (a single ``{stem}_z{z}.fits.fz``, byte-identical to the
    pre-supertile layout). Returns a LevelInfo dict.

    The native array is read via a **read-only** memory-map of the shared ``.npy``
    (mode ``r``), so every level worker shares one copy through the OS page cache.
    Read-only (``MAP_SHARED``/``PROT_READ``) is deliberate over copy-on-write
    (``mode="c"``): nothing here mutates ``native`` (``_downsample`` only reads it,
    copying each supertile out via ``ascontiguousarray``), and under strict overcommit
    (``vm.overcommit_memory=2``) a copy-on-write mapping reserves its FULL size as
    commit charge per worker even though no page is ever written — N workers × a
    multi-GB mosaic blows the commit limit and OOMs at ``mmap()``. A read-only mapping
    charges nothing.
    """
    native = np.load(task.native_npy, mmap_mode="r")

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        native_wcs = WCS(task.header)

    level = _downsample(native, task.factor)
    level_wcs = _scale_wcs(native_wcs, task.factor)
    level_header = level_wcs.to_header(relax=True)

    ts = task.tile_size
    h, w = int(level.shape[0]), int(level.shape[1])
    n_ty, n_tx = _tile_count((h, w), ts)
    blocks = _supertile_blocks(n_tx, n_ty, task.supertile_blocks)
    single = len(blocks) == 1

    supertiles: list[SupertileInfo] = []
    zcmptype = ""
    for (tx0, ty0, snx, sny) in blocks:
        x0, y0 = tx0 * ts, ty0 * ts
        x1, y1 = min((tx0 + snx) * ts, w), min((ty0 + sny) * ts, h)
        # ascontiguousarray is a no-op for the full-grid (single) case — so an
        # un-chunked level stays byte-identical to the old one-file-per-level output.
        sub = np.ascontiguousarray(level[y0:y1, x0:x1])

        # An all-NaN supertile carries no data (a band covering only a subset of its
        # co-gridded group's footprint, or a survey's irregular corner). Drop it: it
        # is omitted from the manifest and never shipped; `resolveSupertile` returns
        # undefined for its tiles and the client falls back to a coarser level whose
        # supertile does cover the region (with NaN), which the shader renders as
        # background. `fpack_tile_count` stays the FULL grid, so tile math is unchanged.
        if bool(np.all(np.isnan(sub))):
            continue

        if single:
            filename = f"{task.stem}_z{task.z}.fits.fz"
            sub_header = level_header
        else:
            filename = f"{task.stem}_z{task.z}_{tx0}_{ty0}.fits.fz"
            # Self-describing cutout: shift CRPIX to the crop origin so the file's own
            # WCS is correct (CRPIX is 1-based; subtract the 0-based crop origin).
            w_sub = level_wcs.deepcopy()
            w_sub.wcs.crpix = level_wcs.wcs.crpix - np.array([x0, y0], dtype=float)
            sub_header = w_sub.to_header(relax=True)

        out_path = os.path.join(task.out_dir, filename)
        zcmptype = _write_supertile(sub, sub_header, out_path, task)

        size = os.path.getsize(out_path)
        if size > task.size_budget:
            raise RuntimeError(
                f"z={task.z}: supertile {filename} is {size} bytes, over the "
                f"{task.size_budget}-byte budget — reduce supertile_blocks "
                f"(currently {task.supertile_blocks}) so each file stays under the "
                f"CDN object-size limit."
            )
        supertiles.append(
            SupertileInfo(filename=filename, tile_origin=[tx0, ty0], tile_count=[snx, sny])
        )

    if not supertiles:
        # Every block was all-NaN — the band has no finite pixels at this level (and,
        # since coarser levels only gain coverage, nowhere). A misconfigured band.
        raise RuntimeError(
            f"z={task.z}: level is entirely NaN (no finite data) — check the band's inputs."
        )

    level_info = LevelInfo(
        z=task.z,
        filename=supertiles[0].filename,
        compression=zcmptype,
        lossless=False,
        shape=[h, w],
        fpack_tile_count=[n_ty, n_tx],
        pixel_scale_arcsec=_pixel_scale_arcsec(level_wcs),
        wcs={k: level_header[k] for k in level_header},
        supertiles=supertiles,
    )
    return level_info.to_dict()


# --------------------------------------------------------------------------- #
# Orchestration
# --------------------------------------------------------------------------- #
def build_pyramid(
    input_path: str | Path | Sequence[str | Path],
    output_dir: str | Path | None = None,
    *,
    stem: str | None = None,
    tile_size: int = FPACK_TILE_SIZE,
    quantize_level: int = DEFAULT_QUANTIZE_LEVEL,
    supertile_blocks: int = DEFAULT_SUPERTILE_BLOCKS,
    size_budget_bytes: int = EDGE_CACHE_LIMIT_BYTES,
    processes: int | None = None,
    verify: bool = True,
    grid_frame: "GridFrame | None" = None,
    on_progress: Callable[[str], None] | None = None,
) -> Manifest:
    """Build a multi-resolution fpacked pyramid from one FITS mosaic.

    Parameters
    ----------
    input_path
        Path to the source FITS mosaic, OR a list of pre-tiled FITS that share one
        pixel grid (same CTYPE/CRVAL/scale, integer-offset CRPIX). Multiple tiles are
        placed onto one virtual native grid (no resampling) before tiling; see
        ``placed_tiles.assemble_placed_tiles``.
    output_dir
        Output directory. Defaults to ``<stem>_pyramid/`` beside the (first) input.
    stem
        Filename stem for the level/supertile files (``{stem}_z{z}…``). Defaults to
        the single input's stem, or the common prefix of multiple tiles' stems.
    tile_size
        fpack-internal tile size (default 256).
    quantize_level
        RICE_1 quantization level applied to every level (default 8).
    supertile_blocks
        Max render-tiles per side per supertile file (``K``, default 48). A level
        whose tile grid exceeds ``K`` in either dim is split into ``K×K``-tile
        supertiles so each ``.fits.fz`` stays edge-cacheable; smaller levels emit a
        single file (byte-identical to the old layout).
    size_budget_bytes
        Hard per-file ceiling (default 512 MB). A supertile over this raises rather
        than shipping a silently-uncacheable file; lower ``supertile_blocks`` if hit.
    processes
        Worker process count. Defaults to one per level (capped at cpu count).
    verify
        Read each written level back and check the lossy round-trip (NaN mask +
        quantization tolerance). Default True; set False to skip the second full
        decode per level on very large mosaics where memory is the constraint (the
        cheap heap-overflow header check still runs).
    grid_frame
        Optional shared :class:`placed_tiles.GridFrame`. When set, the input is
        placed onto that frame's reference + extent (NaN-padded if it covers only a
        subset) so this band co-grids with the others in its group; a single input
        is routed through the placement path too. ``None`` keeps each band on its own
        grid (the default).
    on_progress
        Optional callback invoked with human-readable progress lines (input read,
        levels building, each level as it completes). Defaults to silent.

    Returns
    -------
    Manifest
        The written manifest, also serialized to ``output_dir/manifest.json``.
    """
    if supertile_blocks < 1:
        raise ValueError(f"supertile_blocks must be >= 1 (got {supertile_blocks})")
    raw_inputs = input_path if isinstance(input_path, (list, tuple)) else [input_path]
    input_paths = [Path(p) for p in raw_inputs]
    if not input_paths:
        raise ValueError("build_pyramid: no input given")
    report = on_progress if on_progress is not None else (lambda _msg: None)

    stem = stem or _common_stem(input_paths)
    if output_dir is None:
        output_dir = input_paths[0].parent / f"{stem}_pyramid"
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Stage the native array as a .npy that every level worker memory-maps
    # (read-only) instead of receiving a pickled copy. Under the 'spawn' start
    # method, pickling the full mosaic per level is O(levels × mosaic) of IPC +
    # peak memory and is what makes a large build thrash; the page-cache-backed
    # mmap shares ONE copy. Freed from the parent here, then unlinked when done.
    if len(input_paths) == 1 and grid_frame is None:
        report(f"reading {input_paths[0].name} …")
        data, header = _read_input(input_paths[0])
        native_h, native_w = int(data.shape[0]), int(data.shape[1])
        native_npy = _choose_npy_dir(output_dir, data.nbytes, report) / NATIVE_NPY_NAME
        np.save(native_npy, data)
        del data
        source_file = input_paths[0].name
    else:
        # Pre-tiled input (or a single input padded onto a shared grid frame): place
        # the tiles onto one virtual native grid first, then tile it exactly like a
        # single mosaic. (Lazy import breaks the import cycle.)
        from .placed_tiles import assemble_placed_tiles

        header, (native_h, native_w), native_npy = assemble_placed_tiles(
            input_paths, output_dir, frame=grid_frame, on_progress=report
        )
        n = len(input_paths)
        source_file = f"{stem} ({n} tile{'s' if n != 1 else ''})"
    report(f"read {native_h}×{native_w} mosaic")

    N = n_levels((native_h, native_w), tile_size)

    try:
        tasks = [
            _LevelTask(
                z=z,
                factor=2**z,
                out_dir=str(output_dir),
                stem=stem,
                tile_size=tile_size,
                quantize_level=quantize_level,
                supertile_blocks=supertile_blocks,
                size_budget=size_budget_bytes,
                native_npy=str(native_npy),
                header=header,
                verify=verify,
            )
            for z in range(N + 1)
        ]

        # One process per level -- CompImageHDU writing is not thread-safe within a
        # level, and levels are fully independent, so process-per-level is the clean
        # parallel unit. Single level -> run inline to avoid Pool overhead.
        vnote = "" if verify else " · verify off"
        if len(tasks) == 1:
            report("building 1 level (z=0) …" + vnote)
            level_dicts = [_build_level(tasks[0])]
            report(f"  z0 done — {level_dicts[0]['shape'][0]}×{level_dicts[0]['shape'][1]}")
        else:
            n_proc = processes or min(len(tasks), os.cpu_count() or 1)
            report(f"building {len(tasks)} levels (z=0..{N}) on {n_proc} worker(s) …" + vnote)
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
            source_file=source_file,
            native_shape=[native_h, native_w],
            fpack_tile_size=tile_size,
            n_levels=N,
            levels=levels,
        )
        write_manifest(output_dir / "manifest.json", manifest)
    finally:
        # Drop the transient native array. When it was staged in a private scratch
        # subdir (not the output dir), remove the whole subdir so nothing leaks.
        if native_npy.parent != output_dir:
            shutil.rmtree(native_npy.parent, ignore_errors=True)
        else:
            native_npy.unlink(missing_ok=True)
    return manifest
