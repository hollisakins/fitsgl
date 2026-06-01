/**
 * fits-pyramid — browser-side decoder + renderer for fpacked FITS tile pyramids.
 *
 * Phase 2a: standalone RICE_1 decompression (`riceDecompress`, `BitReader`).
 * Phase 2b: fpack file parsing + tile fetching over HTTP range requests
 * (`TilePyramid` is the high-level API; `FpackFile`/`TileEngine` are lower-level).
 * Phase 3: WebGL2 viewer (`FitsViewer`) with pan/zoom and linear stretch.
 */

// Phase 2a — RICE
export { riceDecompress, BitReader } from './rice/index.js';

// Phase 2b — manifest
export { loadManifest, validateManifest, resolveLevelUrl, SUPPORTED_MANIFEST_VERSION } from './manifest.js';
export type { Manifest, LevelInfo } from './manifest.js';

// Phase 2b — high-level tile access
export { TilePyramid, TileEngine } from './fpack/tile-source.js';
export type { TilePyramidOptions, TileEngineOptions } from './fpack/tile-source.js';

// Phase 2b — lower-level building blocks
export { FpackFile, httpRangeFetch } from './fpack/fpack-file.js';
export type { RangeFetcher, CompressionType } from './fpack/fpack-file.js';
export { decodeRiceTile } from './fpack/decode-rice.js';
export { decodeGzip2Tile, gunzip } from './fpack/decode-gzip2.js';
export { LRUCache } from './lru.js';

// Phase 2b — worker
export { attachTileWorker } from './worker.js';
export type { WorkerLike, WorkerReply, WorkerRequest } from './fpack/worker-protocol.js';

// Phase 3 — WebGL2 viewer
export { FitsViewer, Camera } from './renderer/index.js';
export type { FitsViewerOptions, ViewerFrameInfo, CursorInfo } from './renderer/index.js';
// M4 — RGB composite render source (single band, or three same-grid bands).
export type { RenderSource, SingleBandSource, RgbSource } from './renderer/index.js';
// Phase 3 — tile-selection helpers (for tools/demos building on the viewer).
export { targetLevel, visibleTiles, buildLevelGeoms, TILE_SIZE } from './renderer/index.js';
export type { TileCoord, LevelGeom, WorldRect } from './renderer/index.js';
export type { WorldBounds } from './renderer/index.js';

// M1 — display modes: stretch curves + bundled colormaps (single-band).
export { STRETCH_MODES, isStretchMode } from './renderer/index.js';
export type { StretchMode } from './renderer/index.js';
export { COLORMAP_NAMES, COLORMAP_SIZE, isColormapName, colormapRGB } from './renderer/index.js';
export type { ColormapName, ColormapLUT } from './renderer/index.js';

// M2 — WCS: client-side TAN pixel<->sky (ICRS) + sexagesimal formatting.
export { parseWcs, pixToSky, skyToPix, formatRA, formatDec } from './wcs/index.js';
export type { TanWcs, SkyCoord, PixelCoord } from './wcs/index.js';

// M4 — RGB compositing: grid-compatibility gate + dataset manifest (decisions
// D7/D9). The dataset manifest groups composite-compatible single-band pyramids;
// `gridsMatch` is the authoritative same-grid check. Types flagged M5-narrowable.
export { gridsMatch, GRID_MATCH_SUBPIXEL_FRACTION } from './wcs/index.js';
export type { GridSpec } from './wcs/index.js';
export {
  loadDataset,
  validateDataset,
  resolveDatasetBandUrl,
  bandGridSpec,
  compatibleBands,
  DATASET_VERSION,
} from './dataset.js';
export type { DatasetManifest, DatasetBand, DatasetRgbRoles } from './dataset.js';

// M3 — overlays: catalog/region markers (sky or pixel), instanced WebGL render +
// CPU hit-testing + one reused DOM popup (decision D10).
export {
  MARKER_SHAPES,
  isMarkerShape,
  parseColor,
  parseCatalogCSV,
  CATALOG_VERSION,
} from './overlay/index.js';
export type {
  MarkerInput,
  MarkerPatch,
  ResolvedMarker,
  MarkerShape,
  MarkerEvent,
  MarkerHandlers,
  ColorInput,
  ColorTuple,
} from './overlay/index.js';
