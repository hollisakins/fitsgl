#!/usr/bin/env python3
"""Generate a Python-written dataset.json fixture for the TS client (M4, D9).

`dataset.test.ts` validates the EXACT bytes the `pyramid_gen` writer emits (not a
hand-authored JSON), so a writer/loader schema drift is caught. Three same-grid
bands + a default RGB assignment, written via `pyramid_gen.dataset.write_dataset`.

Run from anywhere (needs `pyramid_gen` importable, e.g. PYTHONPATH=../../pyramid_gen/src):
    python generate_dataset_fixture.py
Writes:  dataset_fixture.json  (next to this script)
"""

from __future__ import annotations

from pathlib import Path

from pyramid_gen.dataset import DatasetBand, DatasetManifest, grid_hash, write_dataset

SCALE = 8.333e-6  # deg/pixel
SHAPE = [512, 512]
WCS = {
    "CTYPE1": "RA---TAN",
    "CTYPE2": "DEC--TAN",
    "CRPIX1": 256.5,
    "CRPIX2": 256.5,
    "CRVAL1": 150.0,
    "CRVAL2": 2.2,
    "PC1_1": -1.0,
    "PC2_2": 1.0,
    "CDELT1": SCALE,
    "CDELT2": SCALE,
}
GRID_HASH = grid_hash(WCS, SHAPE)


def band(name: str) -> DatasetBand:
    return DatasetBand(
        name=name,
        path=f"{name}/manifest.json",
        ctype1="RA---TAN",
        ctype2="DEC--TAN",
        shape=list(SHAPE),
        crpix=[256.5, 256.5],
        crval=[150.0, 2.2],
        cd=[-SCALE, 0.0, 0.0, SCALE],
        pixel_scale_arcsec=0.03,
        grid_hash=GRID_HASH,
    )


manifest = DatasetManifest(
    bands=[band("red"), band("green"), band("blue")],
    default_rgb={"r": "red", "g": "green", "b": "blue"},
)

out_path = Path(__file__).with_name("dataset_fixture.json")
write_dataset(out_path, manifest)
print(f"wrote {out_path}  ({len(manifest.bands)} bands, grid_hash={GRID_HASH})")
