"""pyramid_gen: build multi-resolution fpacked FITS pyramids from mosaics.

Phase 1 of a browser-side FITS mosaic renderer. For each input mosaic this
package produces N+1 separate fpacked FITS files:

- z=0 (native resolution) uses GZIP_2 with quantization disabled -- LOSSLESS.
  This is the canonical science-distribution product.
- z=1..N use RICE_1 with quantize_level=16 -- lossy, smaller, for browser
  visualization only.

All levels share a 256x256 fpack-internal tile size, the unit of HTTP byte
ranges the browser client requests.
"""

from .build_pyramid import (
    FPACK_TILE_SIZE,
    build_pyramid,
    n_levels,
)
from .manifest import LevelInfo, Manifest, read_manifest, write_manifest

__all__ = [
    "FPACK_TILE_SIZE",
    "build_pyramid",
    "n_levels",
    "LevelInfo",
    "Manifest",
    "read_manifest",
    "write_manifest",
]

__version__ = "0.1.0"
