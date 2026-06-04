#!/usr/bin/env python3
"""Generate known-good SUBTRACTIVE_DITHER_2 RICE fixtures for the TS decoder.

Each fixture is one tile from an astropy ``CompImageHDU`` written with
``compression_type='RICE_1'``, ``quantize_level=8``, ``quantize_method=2``
(SUBTRACTIVE_DITHER_2). We extract the tile's raw ``COMPRESSED_DATA`` bytes plus
its ZSCALE/ZZERO/ZBLANK/ZDITHER0 and tile index, and astropy's own decoded
float32 pixels for that tile. The TS ``decodeRiceTile`` (with dither) must
reproduce astropy's pixels to within <=1 float32 ULP, with the NaN mask and the
exact-zero pixels reproduced *exactly*.

The <=1 ULP allowance exists because astropy's C unquantizer evaluates
``value*ZSCALE + ZZERO`` with a fused multiply-add (single rounding) that JS
cannot reproduce; the FITS standard does not mandate FMA. The dither index,
formula, RNG table, NaN-mask and exact-zero handling are all exact -- a logic
error would diverge by many ULPs, not one (this script asserts the gap is <=1).

Tiles are chosen to cover: tile 0 with NaNs + exact zeros; a tile whose
(tileIndex + ZDITHER0 - 1) crosses the 10000 table-wrap boundary; and partial
edge tiles (non-256 dims). Run from anywhere:  python generate_dither_fixtures.py
"""

from __future__ import annotations

import base64
import io
import json
import struct
from pathlib import Path

import numpy as np
from astropy.io import fits
from astropy.io.fits.hdu.compressed._compression import decompress_rice_1_c

ZERO_VALUE = -2147483646


def _f32_key(x: float) -> int:
    """Monotonic ordering key for a float32 (matches the TS helper)."""
    u = struct.unpack("<I", struct.pack("<f", np.float32(x)))[0]
    return u + 0x80000000 if u < 0x80000000 else 0xFFFFFFFF - u


def _max_ulp(a: np.ndarray, b: np.ndarray) -> int:
    """Max float32 ULP distance over finite pixels (NaN positions must agree)."""
    assert np.array_equal(np.isnan(a), np.isnan(b)), "NaN masks differ"
    fin = np.isfinite(a)
    worst = 0
    for x, y in zip(a[fin], b[fin]):
        worst = max(worst, abs(_f32_key(float(x)) - _f32_key(float(y))))
    return worst


def _build(image: np.ndarray, dither_seed: int):
    """Write a dithered CompImageHDU and return (decoded_image, compressed bintable)."""
    hdu = fits.CompImageHDU(
        data=image,
        compression_type="RICE_1",
        tile_shape=(256, 256),
        quantize_level=8,
        quantize_method=2,  # SUBTRACTIVE_DITHER_2
        dither_seed=dither_seed,
    )
    buf = io.BytesIO()
    fits.HDUList([fits.PrimaryHDU(), hdu]).writeto(buf, overwrite=True)
    buf.seek(0)
    decoded = np.asarray(fits.open(buf)[1].data).astype(np.float32)
    buf.seek(0)
    bt = fits.open(buf, disable_image_compression=True)[1]
    return decoded, bt


def _plain_decode(ints, zscale, zzero, zblank, zdither0, tile_index):
    """Non-FMA reference of the TS algorithm, only to measure the ULP gap."""
    N = 10000
    a, m = 16807.0, 2147483647.0
    seed = 1.0
    rand = np.empty(N, dtype=np.float32)
    for i in range(N):
        temp = a * seed
        seed = temp - m * float(int(temp / m))
        rand[i] = np.float32(seed / m)
    iseed = (tile_index + zdither0 - 1) % N
    nextrand = int(np.float32(rand[iseed]) * np.float32(500.0))
    out = np.empty(ints.size, dtype=np.float32)
    for k in range(ints.size):
        v = int(ints[k])
        if v == zblank:
            out[k] = np.float32(np.nan)
        elif v == ZERO_VALUE:
            out[k] = np.float32(0.0)
        else:
            out[k] = np.float32((float(v) - float(rand[nextrand]) + 0.5) * zscale + zzero)
        nextrand += 1
        if nextrand == N:
            iseed = (iseed + 1) % N
            nextrand = int(np.float32(rand[iseed]) * np.float32(500.0))
    return out


def _emit_tile(bt, decoded, tx, ty, name):
    h = bt.header
    ztile1, ztile2 = h["ZTILE1"], h["ZTILE2"]
    znaxis1, znaxis2 = h["ZNAXIS1"], h["ZNAXIS2"]
    nx_tiles = (znaxis1 + ztile1 - 1) // ztile1
    r = ty * nx_tiles + tx
    cell = np.asarray(bt.data["COMPRESSED_DATA"][r], dtype=np.uint8)
    if cell.size == 0:
        raise RuntimeError(f"{name}: tile r={r} used a GZIP fallback (cannot fixture)")
    x0, y0 = tx * ztile1, ty * ztile2
    w = min(ztile1, znaxis1 - x0)
    hgt = min(ztile2, znaxis2 - y0)
    npix = w * hgt
    ref = decoded[y0 : y0 + hgt, x0 : x0 + w].ravel(order="C").astype(np.float32)
    zscale = float(bt.data["ZSCALE"][r])
    zzero = float(bt.data["ZZERO"][r])
    # ZBLANK is only written when the image actually has blank pixels; absent
    # means "no blanks" (the client treats a missing ZBLANK as NaN, which never
    # matches a decoded int). Store null in that case.
    zblank = int(h["ZBLANK"]) if "ZBLANK" in h else None
    zdither0 = int(h["ZDITHER0"])

    ints = np.frombuffer(decompress_rice_1_c(cell.tobytes(), 32, 4, npix), dtype=np.int32)
    plain = _plain_decode(ints, zscale, zzero, zblank, zdither0, r)
    ulp = _max_ulp(plain, ref)

    n_nan = int(np.isnan(ref).sum())
    n_zero = int((ref == 0.0).sum())
    return {
        "name": name,
        "method": h["ZQUANTIZ"],
        "zdither0": zdither0,
        "tile_index": r,
        "n_tiles_x": int(nx_tiles),
        "tile_w": int(w),
        "tile_h": int(hgt),
        "n_pixels": int(npix),
        "block_size": 32,
        "zscale": zscale,
        "zzero": zzero,
        "zblank": zblank,
        "n_nan": n_nan,
        "n_exact_zero": n_zero,
        "max_ulp_plain_vs_astropy": int(ulp),
        "compressed_b64": base64.b64encode(cell.tobytes()).decode("ascii"),
        # astropy's decoded float32 pixels, little-endian, row-major within the tile
        "decoded_b64": base64.b64encode(ref.astype("<f4").tobytes()).decode("ascii"),
    }


def _emit_integration_fixture(out_dir: Path) -> None:
    """Write a real multi-tile dithered .fits.fz + astropy's full decode.

    Exercises the FpackFile -> getTile path end to end: open() must read ZQUANTIZ
    /ZDITHER0, and getTile must pass the right per-tile index into the dither.
    """
    rng = np.random.default_rng(424242)
    n = 256  # 2x2 tiles at tile_shape 128
    img = rng.normal(30.0, 4.0, size=(n, n)).astype(np.float32)
    img[5:25, 5:25] = np.nan       # blanks (tile 0,0)
    img[40:60, 40:60] = 0.0        # exact zeros (tile 0,0)
    img[200, 200] = 5000.0         # a source in tile (1,1)
    DITHER = 4242
    hdu = fits.CompImageHDU(
        data=img,
        compression_type="RICE_1",
        tile_shape=(128, 128),
        quantize_level=8,
        quantize_method=2,
        dither_seed=DITHER,
    )
    fits.HDUList([fits.PrimaryHDU(), hdu]).writeto(out_dir / "dither_pyramid.fits.fz", overwrite=True)

    with fits.open(out_dir / "dither_pyramid.fits.fz") as hdul:
        decoded = np.asarray(hdul[1].data).astype(np.float32)
    with fits.open(out_dir / "dither_pyramid.fits.fz", disable_image_compression=True) as hdul:
        h = hdul[1].header
        meta = {
            "znaxis1": int(h["ZNAXIS1"]),
            "znaxis2": int(h["ZNAXIS2"]),
            "ztile1": int(h["ZTILE1"]),
            "ztile2": int(h["ZTILE2"]),
            "zdither0": int(h["ZDITHER0"]),
            "zquantiz": h["ZQUANTIZ"],
            "n_tiles_x": (int(h["ZNAXIS1"]) + int(h["ZTILE1"]) - 1) // int(h["ZTILE1"]),
            "n_tiles_y": (int(h["ZNAXIS2"]) + int(h["ZTILE2"]) - 1) // int(h["ZTILE2"]),
            # full image, astropy's decode, float32 LE row-major
            "decoded_b64": base64.b64encode(decoded.ravel(order="C").astype("<f4").tobytes()).decode("ascii"),
        }
    assert meta["zdither0"] == DITHER and meta["zquantiz"] == "SUBTRACTIVE_DITHER_2"
    (out_dir / "dither_pyramid_expected.json").write_text(json.dumps(meta) + "\n")
    print(f"wrote integration fixture dither_pyramid.fits.fz ({meta['n_tiles_x']}x{meta['n_tiles_y']} tiles)")


def main() -> None:
    rng = np.random.default_rng(20260601)

    # Image A: 768x768 -> 3x3 full 256 tiles. Seed 9999 so tile 2 hits the
    # table-wrap boundary ((2 + 9999 - 1) == 10000). Tile 0 carries NaNs + zeros.
    a = rng.normal(50.0, 5.0, size=(768, 768)).astype(np.float32)
    a[10:50, 10:50] = np.nan          # blank region (in tile 0)
    a[120:170, 120:170] = 0.0         # exact zeros (in tile 0) -> DITHER_2 sentinel
    a[300, 400] = 6000.0
    a[600, 100] = 9000.0
    decA, btA = _build(a, dither_seed=9999)

    # Image B: 640x640 -> edge tiles (last row/col are 128 px). Tests partial dims.
    b = rng.normal(120.0, 8.0, size=(640, 640)).astype(np.float32)
    b[500, 500] = 7000.0
    decB, btB = _build(b, dither_seed=1234)

    tiles = [
        _emit_tile(btA, decA, tx=0, ty=0, name="full_tile0_nan_zero_seed9999"),
        _emit_tile(btA, decA, tx=2, ty=0, name="full_tile2_table_wrap_boundary"),
        _emit_tile(btA, decA, tx=1, ty=1, name="full_tile_center"),
        _emit_tile(btB, decB, tx=2, ty=2, name="edge_tile_corner_128x128"),
        _emit_tile(btB, decB, tx=2, ty=0, name="edge_tile_right_128x256"),
    ]

    worst = max(t["max_ulp_plain_vs_astropy"] for t in tiles)
    # Sanity: the dither logic is exact; only FMA rounding differs, so <=1 ULP.
    assert worst <= 1, f"plain decode diverged from astropy by {worst} ULPs (logic bug?)"
    # Sanity: tile 0 actually exercises both special-cases.
    assert tiles[0]["n_nan"] > 0 and tiles[0]["n_exact_zero"] > 0, tiles[0]

    out = {
        "_comment": (
            "SUBTRACTIVE_DITHER_2 RICE_1 (q=8) fixtures from astropy "
            "(generate_dither_fixtures.py). decoded_b64 is astropy's decode "
            "(float32 LE, row-major within the tile). The TS decodeRiceTile must "
            "match to <=1 float32 ULP (astropy's C uses an FMA JS can't repro); "
            "NaN mask and exact-zero pixels must match exactly."
        ),
        "max_ulp_plain_vs_astropy": int(worst),
        "count": len(tiles),
        "tiles": tiles,
    }
    out_path = Path(__file__).resolve().parent / "dither_fixtures.json"
    out_path.write_text(json.dumps(out, indent=2) + "\n")
    print(f"wrote {len(tiles)} dither fixtures to {out_path} (max ULP vs astropy: {worst})")

    _emit_integration_fixture(out_path.parent)
    for t in tiles:
        print(f"  {t['name']:36s} r={t['tile_index']:2d} npix={t['n_pixels']:6d} "
              f"nan={t['n_nan']:4d} zero={t['n_exact_zero']:4d} ulp={t['max_ulp_plain_vs_astropy']}")


if __name__ == "__main__":
    main()
