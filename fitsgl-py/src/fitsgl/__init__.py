"""fitsgl: build multi-resolution fpacked FITS pyramids from mosaics.

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

# Read-side / server-cutout API (issue #17). Pure tile geometry + level selection
# (`tiles`), fpack byte-range addressing (`fpack_index`), and the astropy-backed
# cutout planner (`cutout`). `tiles`/`fpack_index` avoid astropy so a consumer can
# do all the addressing without it; `cutout` projects sky<->pixel with astropy.
from .tiles import (
    TileCoord,
    PixelBBox,
    SupertileMatch,
    resolve_supertile,
    select_level,
    select_level_index,
    tiles_for_pixel_bbox,
    tile_pixel_bounds,
    pixel_to_tile,
    level_tile_grid,
)
from .fpack_index import (
    SupertileIndex,
    ByteRange,
    TileParams,
    coalesce_ranges,
    IncompleteHeaderError,
)
from .cutout import CutoutPlan, TileRef, plan_cutout

__all__ = [
    "FPACK_TILE_SIZE",
    "build_pyramid",
    "n_levels",
    "LevelInfo",
    "Manifest",
    "SupertileInfo",
    "read_manifest",
    "write_manifest",
    # read-side geometry
    "TileCoord",
    "PixelBBox",
    "SupertileMatch",
    "resolve_supertile",
    "select_level",
    "select_level_index",
    "tiles_for_pixel_bbox",
    "tile_pixel_bounds",
    "pixel_to_tile",
    "level_tile_grid",
    # fpack byte addressing
    "SupertileIndex",
    "ByteRange",
    "TileParams",
    "coalesce_ranges",
    "IncompleteHeaderError",
    # cutout planner
    "CutoutPlan",
    "TileRef",
    "plan_cutout",
]

__version__ = "0.1.0"
