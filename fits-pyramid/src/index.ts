/**
 * fits-pyramid — browser-side decoder for fpacked FITS tile pyramids.
 *
 * Phase 2a: standalone RICE_1 decompression (`riceDecompress`, `BitReader`).
 * Phase 2b: fpack file parsing + tile fetching over HTTP range requests
 * (`TilePyramid` is the high-level API; `FpackFile`/`TileEngine` are lower-level).
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
