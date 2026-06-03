"""pyramid_gen: build multi-resolution fpacked FITS pyramids from mosaics.

Phase 1 of a browser-side FITS mosaic renderer. For each input mosaic this
package produces N+1 separate fpacked FITS files, one per resolution level.

Every level (z=0..N) uses RICE_1 with quantize_level=8 and SUBTRACTIVE_DITHER_2
-- a lossy, display-only product (q=8 preserves photometry to ~0.03% on real
data). The raw, lossless science mosaic is distributed separately, not here.

All levels share a 256x256 fpack-internal tile size, the unit of HTTP byte
ranges the browser client requests.
"""

from .build_pyramid import (
    FPACK_TILE_SIZE,
    build_pyramid,
    n_levels,
)
from .manifest import LevelInfo, Manifest, SupertileInfo, read_manifest, write_manifest

__all__ = [
    "FPACK_TILE_SIZE",
    "build_pyramid",
    "n_levels",
    "LevelInfo",
    "Manifest",
    "SupertileInfo",
    "read_manifest",
    "write_manifest",
]

__version__ = "0.1.0"
