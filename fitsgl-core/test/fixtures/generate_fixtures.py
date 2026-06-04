#!/usr/bin/env python3
"""Generate known-good RICE fixtures for the TypeScript decoder (Phase 2a).

Each fixture is an (int32 input array, RICE-compressed bytes) pair produced by
astropy, the canonical encoder. The TypeScript ``riceDecompress`` must reproduce
the input EXACTLY from the compressed bytes (RICE is lossless). Tests load only
this JSON and never call astropy, so the suite has no runtime astropy dependency.

Two encoders are used, and both are astropy's own RICE implementation:

* The default path writes each int32 array as a single-tile ``CompImageHDU`` with
  ``compression_type='RICE_1'`` and extracts the ``COMPRESSED_DATA`` bytes from
  the resulting BINTABLE. With integer source data no quantization happens
  (``ZQUANTIZ`` is absent, ``ZBITPIX == 32``), so the RICE step is exercised in
  isolation. These bytes are byte-for-byte what the Phase 2b tile fetcher will
  read out of a real fpack file, so the fixtures are faithful to the full
  pipeline.

* A few fixtures use a non-default block size (16, 64). ``CompImageHDU`` always
  uses block size 32, so those are produced with the low-level
  ``compress_rice_1_c(bytes, blocksize, bytepix)`` codec instead -- which is the
  exact function ``CompImageHDU`` calls internally, and which produces
  byte-identical output to the BINTABLE route at block size 32 (asserted below).

Run from anywhere:  python generate_fixtures.py
Writes:             rice_fixtures.json  (next to this script)
"""

from __future__ import annotations

import base64
import io
import json
from pathlib import Path

import numpy as np
from astropy.io import fits
from astropy.io.fits.hdu.compressed._compression import (
    compress_rice_1_c,
    decompress_rice_1_c,
)

INT32_MAX = np.iinfo(np.int32).max  # 2147483647
INT32_MIN = np.iinfo(np.int32).min  # -2147483648


# --------------------------------------------------------------------------- #
# Encoders (both are astropy's own RICE)
# --------------------------------------------------------------------------- #
def _compress_via_compimage(arr: np.ndarray) -> bytes:
    """Single-tile CompImageHDU -> the tile's COMPRESSED_DATA bytes (block size 32)."""
    arr = np.ascontiguousarray(arr, dtype=np.int32)
    n = arr.size
    img = arr.reshape(1, n)
    hdu = fits.CompImageHDU(
        data=img,
        compression_type="RICE_1",
        tile_shape=(1, n),
        quantize_level=16,  # ignored for integer data -- no quantization occurs
    )
    buf = io.BytesIO()
    fits.HDUList([fits.PrimaryHDU(), hdu]).writeto(buf, overwrite=True)
    buf.seek(0)
    with fits.open(buf, disable_image_compression=True) as hdul:
        bt = hdul[1]
        assert bt.header["ZCMPTYPE"] == "RICE_1", bt.header["ZCMPTYPE"]
        assert bt.header["ZBITPIX"] == 32, bt.header["ZBITPIX"]
        assert bt.header.get("ZQUANTIZ") is None, bt.header.get("ZQUANTIZ")
        assert bt.header["NAXIS2"] == 1, "expected exactly one tile"
        cell = np.asarray(bt.data["COMPRESSED_DATA"][0], dtype=np.uint8)
    return cell.tobytes()


def _compress_via_lowlevel(arr: np.ndarray, block_size: int) -> bytes:
    """Low-level codec at an arbitrary block size."""
    arr = np.ascontiguousarray(arr, dtype=np.int32)
    return bytes(compress_rice_1_c(arr.tobytes(), block_size, 4))


def _roundtrip_ok(arr: np.ndarray, comp: bytes, block_size: int) -> bool:
    """Sanity check: astropy decodes its own bytes back to the input exactly."""
    arr = np.ascontiguousarray(arr, dtype=np.int32)
    dec = decompress_rice_1_c(comp, block_size, 4, arr.size)
    back = np.frombuffer(dec, dtype=np.int32)
    return bool(np.array_equal(arr, back))


# --------------------------------------------------------------------------- #
# Input array zoo
# --------------------------------------------------------------------------- #
def _alternating(n: int, lo: int, hi: int) -> np.ndarray:
    a = np.empty(n, dtype=np.int64)
    a[0::2] = lo
    a[1::2] = hi
    return a.astype(np.int32)


def build_inputs() -> list[tuple[str, np.ndarray, int]]:
    """Return (name, int32 array, block_size) triples covering the spec's cases."""
    inputs: list[tuple[str, np.ndarray, int]] = []

    def add(name: str, arr, block_size: int = 32) -> None:
        inputs.append((name, np.asarray(arr, dtype=np.int32), block_size))

    rng = np.random.default_rng(20260529)

    # --- constant arrays at various lengths (low-entropy blocks) ---
    for n in (1, 2, 32, 33, 100, 1024):
        add(f"all_zeros_{n}", np.zeros(n))
        add(f"all_ones_{n}", np.ones(n))
    add("all_int32_max_100", np.full(100, INT32_MAX))
    add("all_int32_min_100", np.full(100, INT32_MIN))
    add("all_neg_one_100", np.full(100, -1))

    # --- single / tiny values (sign + header coverage) ---
    add("single_zero", np.array([0]))
    add("single_one", np.array([1]))
    add("single_neg", np.array([-12345]))
    add("single_int32_max", np.array([INT32_MAX]))
    add("single_int32_min", np.array([INT32_MIN]))
    add("two_vals", np.array([7, -7]))

    # --- alternating patterns (force a spread of FS values) ---
    add("alt_0_1_64", _alternating(64, 0, 1))
    add("alt_small_100", _alternating(100, -3, 4))
    add("alt_large_128", _alternating(128, 0, 2_000_000_000))  # high-entropy
    # Alternating INT32_MIN/INT32_MAX is a *sign-extreme* test, not high-entropy:
    # the 32-bit-wrapping consecutive differences are a constant +-1, which zigzag
    # to {1,2}, so the encoder picks fs=0 (normal Rice). Genuine high-entropy
    # (fs==FSMAX) coverage comes from alt_large_128 and the random full-int32 sets.
    add("alt_int32_minmax_64", _alternating(64, INT32_MIN, INT32_MAX))  # sign extremes, fs=0

    # --- ramps (constant non-zero differences) ---
    add("ramp_up_1024", np.arange(1024))
    add("ramp_down_1024", np.arange(1024, 0, -1))
    add("ramp_up_33", np.arange(33))
    add("ramp_big_step_100", np.arange(0, 100 * 65537, 65537)[:100])

    # --- random small / large ---
    add("rand_small_100", rng.integers(-50, 50, size=100))
    add("rand_small_1024", rng.integers(-1000, 1000, size=1024))
    add("rand_mid_1024", rng.integers(-(2**20), 2**20, size=1024))
    add("rand_full_int32_1024", rng.integers(INT32_MIN, INT32_MAX, size=1024, dtype=np.int64))
    add("rand_full_int32_32768", rng.integers(INT32_MIN, INT32_MAX, size=32768, dtype=np.int64))

    # --- extreme outliers on a quiet background (mixes low- and high-entropy blocks) ---
    spikes = rng.integers(-5, 5, size=2048).astype(np.int64)
    spikes[17] = INT32_MAX
    spikes[300] = INT32_MIN
    spikes[1000] = 1_500_000_000
    spikes[1999] = -1_500_000_000
    add("outliers_2048", spikes)

    # --- large arrays at the required lengths ---
    add("ramp_32768", np.arange(32768))
    add("rand_small_32768", rng.integers(-100, 100, size=32768))
    add("rand_small_100000", rng.integers(-100, 100, size=100000))
    add("ramp_100000", np.arange(100000))
    add("constant_100000", np.full(100000, 42))

    # --- partial final blocks for the high-entropy branch (coverage hardening) ---
    # Full-range int32 randoms force fs==FSMAX (high-entropy, direct 32-bit coding).
    # Non-block-aligned lengths make the LAST high-entropy block partial
    # (imax - i < nblock): n=1000 -> 8-pixel tail; n=33 -> 1-pixel tail.
    add("rand_full_int32_1000", rng.integers(INT32_MIN, INT32_MAX, size=1000, dtype=np.int64))
    add("rand_full_int32_33", rng.integers(INT32_MIN, INT32_MAX, size=33, dtype=np.int64))
    add("rand_full_int32_130", rng.integers(INT32_MIN, INT32_MAX, size=130, dtype=np.int64))

    # --- upper normal-fs band (fs ~ 21..24, just below the FSMAX cutoff) ---
    # Cumulative sums of bounded random steps keep the per-block optimal split
    # parameter in the normal Rice range without tipping into high-entropy.
    for k in (22, 23, 24):
        steps = rng.integers(-(2**k), 2**k, size=400, dtype=np.int64)
        add(f"normal_fs_band_{k}_400", np.cumsum(steps).astype(np.int64))

    # --- non-default block sizes (exercise the blockSize parameter) ---
    add("blocksize16_ramp_100", np.arange(100), 16)
    add("blocksize64_rand_500", rng.integers(-200, 200, size=500), 64)
    add("blocksize16_outliers_300", _alternating(300, -2, 2), 16)

    return inputs


# --------------------------------------------------------------------------- #
# Driver
# --------------------------------------------------------------------------- #
def main() -> None:
    inputs = build_inputs()

    # Cross-check: at block size 32 the two encoders agree byte-for-byte.
    probe = np.arange(257, dtype=np.int32)
    assert _compress_via_compimage(probe) == _compress_via_lowlevel(probe, 32), (
        "CompImageHDU COMPRESSED_DATA and the low-level codec disagree at block "
        "size 32 -- the fixture routes are not equivalent"
    )

    fixtures = []
    for name, arr, block_size in inputs:
        arr = np.ascontiguousarray(arr, dtype=np.int32)
        if block_size == 32:
            comp = _compress_via_compimage(arr)
        else:
            comp = _compress_via_lowlevel(arr, block_size)

        if not _roundtrip_ok(arr, comp, block_size):
            raise RuntimeError(f"fixture {name!r} does not round-trip through astropy")

        fixtures.append(
            {
                "name": name,
                "n_values": int(arr.size),
                "block_size": int(block_size),
                # little-endian int32 bytes of the original array
                "expected_b64": base64.b64encode(arr.tobytes()).decode("ascii"),
                "compressed_b64": base64.b64encode(comp).decode("ascii"),
            }
        )

    names = [f["name"] for f in fixtures]
    assert len(names) == len(set(names)), "duplicate fixture names"

    out = {
        "_comment": (
            "Known-good RICE_1 fixtures generated by astropy (see "
            "generate_fixtures.py). expected_b64 is little-endian int32; "
            "compressed_b64 is the RICE bitstream (== fpack COMPRESSED_DATA). "
            "RICE is lossless: decoding compressed_b64 must reproduce expected_b64 "
            "exactly."
        ),
        "count": len(fixtures),
        "fixtures": fixtures,
    }

    out_path = Path(__file__).resolve().parent / "rice_fixtures.json"
    out_path.write_text(json.dumps(out, indent=2) + "\n")
    total = sum(len(base64.b64decode(f["compressed_b64"])) for f in fixtures)
    print(f"wrote {len(fixtures)} fixtures to {out_path} ({total} compressed bytes total)")


if __name__ == "__main__":
    main()
