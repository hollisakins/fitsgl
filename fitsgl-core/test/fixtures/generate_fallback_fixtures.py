#!/usr/bin/env python3
"""Generate a whole-file fixture exercising the per-tile GZIP fallback.

When a tile has no quantizable signal — every pixel NaN (a band's empty region
on a shared grid) or a constant value — cfitsio/astropy cannot derive a
quantization scale, so lossy RICE writing falls back PER TILE to gzipping the
raw big-endian float32 pixels into the ``GZIP_COMPRESSED_DATA`` column, leaving
``COMPRESSED_DATA`` empty. Real fitsgl pyramids hit this on every shared-grid
band that covers only part of its field (the CAMPFIRE partial-filter-coverage
case), so the TS client must decode these tiles — bit-exactly, since the
fallback is lossless.

The fixture is one 512x512 SUBTRACTIVE_DITHER_2 RICE_1 (q=8) file with 2x2
tiles of 256x256:

  (0,0) noise + a NaN patch + exact zeros  -> normal RICE (quantized)
  (1,0) all NaN                            -> GZIP fallback
  (0,1) constant 3.25                      -> GZIP fallback
  (1,1) noise                              -> normal RICE (quantized)

Expected pixels are astropy's own decode of the file: exact for the fallback
tiles (lossless), <=1 float32 ULP for the quantized tiles (astropy's C
unquantizer uses an FMA JS cannot reproduce; see generate_dither_fixtures.py).
Run from anywhere:  python generate_fallback_fixtures.py
"""

from __future__ import annotations

import base64
import io
import json
from pathlib import Path

import numpy as np
from astropy.io import fits


def main() -> None:
    rng = np.random.default_rng(4242)
    img = rng.normal(0.0, 1.0, (512, 512)).astype(np.float32) + 5.0
    # (0,0): NaN patch + exact zeros inside an otherwise-noisy quantized tile.
    img[10:40, 10:40] = np.nan
    img[60:70, 60:70] = 0.0
    # (1,0): all NaN — the shared-grid empty-region tile.
    img[0:256, 256:512] = np.nan
    # (0,1): constant — the other unquantizable shape.
    img[256:512, 0:256] = 3.25

    hdu = fits.CompImageHDU(
        data=img,
        compression_type="RICE_1",
        tile_shape=(256, 256),
        quantize_level=8,
        quantize_method=2,  # SUBTRACTIVE_DITHER_2
        dither_seed=777,
    )
    buf = io.BytesIO()
    fits.HDUList([fits.PrimaryHDU(), hdu]).writeto(buf, overwrite=True)

    buf.seek(0)
    decoded = np.asarray(fits.open(buf)[1].data).astype(np.float32)
    buf.seek(0)
    bt = fits.open(buf, disable_image_compression=True)[1]

    # Which BINTABLE rows actually took the fallback (empty COMPRESSED_DATA)?
    fallback_rows = [
        r for r in range(4) if np.asarray(bt.data["COMPRESSED_DATA"][r]).size == 0
    ]
    for r in fallback_rows:
        assert np.asarray(bt.data["GZIP_COMPRESSED_DATA"][r]).size > 0, r
    # Rows are row-major over the 2x2 tile grid: (1,0) -> 1, (0,1) -> 2.
    assert fallback_rows == [1, 2], (
        f"expected tiles (1,0) and (0,1) to take the GZIP fallback, got rows "
        f"{fallback_rows} — astropy's fallback behaviour changed; revisit the fixture."
    )
    # The fallback is lossless: astropy's decode must equal the input bit-for-bit.
    assert np.all(np.isnan(decoded[0:256, 256:512]))
    assert np.array_equal(decoded[256:512, 0:256], img[256:512, 0:256])

    h = bt.header
    out_dir = Path(__file__).resolve().parent
    file_bytes = buf.getvalue()
    (out_dir / "fallback_pyramid.fits.fz").write_bytes(file_bytes)
    meta = {
        "_comment": (
            "GZIP-fallback fixture (generate_fallback_fixtures.py). Tiles (1,0) "
            "and (0,1) use the per-tile lossless GZIP fallback and must decode "
            "bit-exactly; the quantized tiles match astropy to <=1 float32 ULP."
        ),
        "znaxis1": int(h["ZNAXIS1"]),
        "znaxis2": int(h["ZNAXIS2"]),
        "ztile1": int(h["ZTILE1"]),
        "ztile2": int(h["ZTILE2"]),
        "zdither0": int(h["ZDITHER0"]),
        "zquantiz": str(h["ZQUANTIZ"]),
        "n_tiles_x": 2,
        "n_tiles_y": 2,
        "fallback_tiles": [[1, 0], [0, 1]],
        "decoded_b64": base64.b64encode(
            decoded.astype("<f4").tobytes(order="C")
        ).decode("ascii"),
    }
    (out_dir / "fallback_pyramid_expected.json").write_text(
        json.dumps(meta, indent=2) + "\n"
    )
    print(
        f"wrote fallback_pyramid.fits.fz ({len(file_bytes)} bytes) + expected json; "
        f"fallback rows: {fallback_rows}"
    )


if __name__ == "__main__":
    main()
