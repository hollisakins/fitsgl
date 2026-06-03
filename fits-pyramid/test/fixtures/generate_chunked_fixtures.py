#!/usr/bin/env python3
"""Generate a CHUNKED (v2 supertiles) pyramid fixture for the cross-language test.

Builds a real pyramid from the same 512x512 synthetic mosaic as ``pyramid2b`` but
with ``supertile_blocks=1``, so the z=0 level (a 2x2 tile grid) is split into FOUR
single-tile supertiles. This is the only fixture that exercises a level spread
across multiple ``.fits.fz`` files, proving the TypeScript client resolves a global
tile to the right supertile + local coords and decodes it bit-for-bit vs astropy.

Produces, under ``chunked/`` next to this script:

  chunked/
    manifest.json                  # v2 manifest: z=0 has 4 supertiles, z=1 has 1
    synthetic_z0_0_0.fits.fz       # the four z=0 supertiles (one render-tile each)
    synthetic_z0_1_0.fits.fz
    synthetic_z0_0_1.fits.fz
    synthetic_z0_1_1.fits.fz
    synthetic_z1.fits.fz           # z=1 fits one block -> single (un-chunked) file
    z0_1_1_decoded.bin             # astropy's RICE q8 decode of the (1,1) supertile

The TS test loads the manifest, calls getTile(0, 1, 1) — global tile (1,1), which
lives in the supertile at tile_origin [1,1] at local (0,0) — and compares the decode
to ``z0_1_1_decoded.bin`` within <=1 ULP (the dither FMA tolerance).

Run:    python generate_chunked_fixtures.py
"""

from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path

import numpy as np
from astropy.io import fits

from pyramid_gen.build_pyramid import build_pyramid
from pyramid_gen.synthetic import generate_synthetic_mosaic

HERE = Path(__file__).resolve().parent
OUT = HERE / "chunked"


def main() -> None:
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)

    work = tempfile.mkdtemp(prefix="chunked_fix_")
    img, hdr, _ = generate_synthetic_mosaic(shape=(512, 512), seed=1234, nan_fraction=0.02)
    img = img.astype(np.float32)
    src = os.path.join(work, "synthetic.fits")
    fits.PrimaryHDU(data=img, header=hdr).writeto(src, overwrite=True)

    # supertile_blocks=1 -> z=0 (2x2 tiles) splits into 4 single-tile supertiles.
    manifest = build_pyramid(src, output_dir=OUT, processes=1, supertile_blocks=1)

    z0 = manifest.levels[0]
    assert len(z0.supertiles) == 4, f"expected 4 z=0 supertiles, got {len(z0.supertiles)}"
    st = next(s for s in z0.supertiles if s.tile_origin == [1, 1])
    with fits.open(OUT / st.filename) as hdul:
        decoded = np.ascontiguousarray(hdul[1].data, dtype="<f4")  # 256x256
    (OUT / "z0_1_1_decoded.bin").write_bytes(decoded.tobytes())

    # The build leaves a staging _native.npy in the out dir; drop it from the fixture.
    (OUT / "_native.npy").unlink(missing_ok=True)

    sizes = {p.name: p.stat().st_size for p in sorted(OUT.iterdir())}
    print("wrote chunked fixtures:")
    for name, size in sizes.items():
        print(f"  {name:28s} {size:>9d} bytes")


if __name__ == "__main__":
    main()
