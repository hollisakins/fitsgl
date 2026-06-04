#!/usr/bin/env python3
"""Generate Phase 2b fpack fixtures by running the Phase 1 pipeline.

Produces, under ``pyramid2b/`` next to this script, a real two-level pyramid from
a 512x512 synthetic mosaic (with NaN blobs), plus committed ground truth so the
TypeScript tests need no astropy at runtime:

  pyramid2b/
    manifest.json            # Phase 1 manifest
    synthetic_z0.fits.fz     # GZIP_2 (lossless), 512x512, 2x2 tiles
    synthetic_z1.fits.fz     # RICE_1 (q=16), 256x256, 1 tile
    native.bin               # float32 LE 512x512 -- the exact input to z0
    z1_decoded.bin           # float32 LE 256x256 -- astropy's RICE decode of z1
    expected.json            # metadata + one sample tile (raw bytes) per codec

The z0 file is lossless, so its decoded tiles must equal ``native.bin`` exactly
(NaN positions included). ``z1_decoded.bin`` is astropy's own decode of the RICE
tile, which the TypeScript decoder must reproduce. The two ``sample*`` blocks in
expected.json give decode-rice / decode-gzip2 known-input bytes without needing
the full BINTABLE parser.

Run:    python generate_pyramid_fixtures.py
"""

from __future__ import annotations

import base64
import json
import os
import shutil
import tempfile
from pathlib import Path

import numpy as np
from astropy.io import fits

from fitsgl.build_pyramid import build_pyramid
from fitsgl.synthetic import generate_synthetic_mosaic

HERE = Path(__file__).resolve().parent
OUT = HERE / "pyramid2b"


def _extract_tile(path: str, row: int):
    """Return (compressed_bytes, zscale, zzero) for a BINTABLE row of an fpack file."""
    with fits.open(path, disable_image_compression=True) as hdul:
        bt = hdul[1]
        names = bt.columns.names
        comp = np.asarray(bt.data["COMPRESSED_DATA"][row], dtype=np.uint8).tobytes()
        zscale = float(bt.data["ZSCALE"][row]) if "ZSCALE" in names else None
        zzero = float(bt.data["ZZERO"][row]) if "ZZERO" in names else None
    return comp, zscale, zzero


def main() -> None:
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)

    work = tempfile.mkdtemp(prefix="p2b_fix_")
    img, hdr, _ = generate_synthetic_mosaic(shape=(512, 512), seed=1234, nan_fraction=0.02)
    img = img.astype(np.float32)
    src = os.path.join(work, "synthetic.fits")
    fits.PrimaryHDU(data=img, header=hdr).writeto(src, overwrite=True)

    manifest = build_pyramid(src, output_dir=OUT, processes=1)

    # Native array (exact input to the lossless z0 level), C-order float32 LE.
    (OUT / "native.bin").write_bytes(np.ascontiguousarray(img, dtype="<f4").tobytes())

    # Ground-truth astropy decode of each level.
    levels_meta = []
    z1_decoded = None
    for lvl in manifest.levels:
        path = str(OUT / lvl.filename)
        with fits.open(path) as hdul:
            decoded = np.ascontiguousarray(hdul[1].data, dtype="<f4")
        ntiles_y, ntiles_x = lvl.fpack_tile_count
        meta = {
            "z": lvl.z,
            "filename": lvl.filename,
            "compression": lvl.compression,
            "shape": [int(lvl.shape[0]), int(lvl.shape[1])],
            "nTilesX": int(ntiles_x),
            "nTilesY": int(ntiles_y),
        }
        if lvl.compression == "RICE_1":
            with fits.open(path, disable_image_compression=True) as hdul:
                zblank = hdul[1].header.get("ZBLANK")
            meta["zblank"] = int(zblank) if zblank is not None else None
            z1_decoded = decoded
        levels_meta.append(meta)

    if z1_decoded is not None:
        (OUT / "z1_decoded.bin").write_bytes(z1_decoded.tobytes())

    # Sample tiles (raw codec bytes) for the unit-level decode tests.
    z0_name = manifest.levels[0].filename
    z1_name = manifest.levels[1].filename
    gzip_bytes, _, _ = _extract_tile(str(OUT / z0_name), 0)  # tile (0,0)
    rice_bytes, zscale, zzero = _extract_tile(str(OUT / z1_name), 0)
    with fits.open(str(OUT / z1_name), disable_image_compression=True) as hdul:
        zblank = int(hdul[1].header["ZBLANK"])
        blocksize = int(hdul[1].header.get("ZBLOCKSIZE", 32))

    expected = {
        "tileSize": int(manifest.fpack_tile_size),
        "nativeShape": [int(manifest.native_shape[0]), int(manifest.native_shape[1])],
        "levels": levels_meta,
        "native": {"file": "native.bin", "shape": [512, 512]},
        "z1Decoded": {"file": "z1_decoded.bin", "shape": [256, 256]},
        "sampleGzip2Tile": {
            "level": 0,
            "tileX": 0,
            "tileY": 0,
            "nPixels": 256 * 256,
            "compressed_b64": base64.b64encode(gzip_bytes).decode("ascii"),
            # expected = native[0:256, 0:256]
        },
        "sampleRiceTile": {
            "level": 1,
            "tileX": 0,
            "tileY": 0,
            "nPixels": 256 * 256,
            "blockSize": blocksize,
            "zscale": zscale,
            "zzero": zzero,
            "zblank": zblank,
            "compressed_b64": base64.b64encode(rice_bytes).decode("ascii"),
            # expected = z1_decoded (whole image, single tile)
        },
    }
    (OUT / "expected.json").write_text(json.dumps(expected, indent=2) + "\n")

    # A lossless/integer RICE file: int32 source -> RICE with NO ZSCALE/ZZERO
    # columns. The float tile pipeline cannot reconstruct floats from it and must
    # reject it loudly (rather than silently returning an all-NaN tile).
    ints = (np.arange(256 * 256, dtype=np.int32) % 1000).reshape(256, 256)
    lossless = fits.CompImageHDU(
        data=ints, compression_type="RICE_1", tile_shape=(256, 256)
    )
    fits.HDUList([fits.PrimaryHDU(), lossless]).writeto(
        OUT / "lossless_rice.fits.fz", overwrite=True
    )

    sizes = {p.name: p.stat().st_size for p in sorted(OUT.iterdir())}
    print("wrote pyramid2b fixtures:")
    for name, size in sizes.items():
        print(f"  {name:24s} {size:>9d} bytes")


if __name__ == "__main__":
    main()
