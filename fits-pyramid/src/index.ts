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
export { loadManifest, validateManifest, resolveLevelUrl } from './manifest.js';
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
export type { FitsViewerOptions, ViewerFrameInfo } from './renderer/index.js';
// Phase 3 — tile-selection helpers (for tools/demos building on the viewer).
export { targetLevel, visibleTiles, buildLevelGeoms, TILE_SIZE } from './renderer/index.js';
export type { TileCoord, LevelGeom, WorldRect } from './renderer/index.js';
export type { WorldBounds } from './renderer/index.js';
