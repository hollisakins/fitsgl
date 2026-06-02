/**
 * fits-pyramid/internal — lower-level building blocks **not** covered by the v1.0
 * stability contract (decision D11). Imported by tools, tests, and advanced hosts
 * that knowingly opt out of the narrow public surface in `fits-pyramid`. Anything
 * re-exported here may change in a minor release; depend on it deliberately.
 *
 * (The unit tests reach these modules by relative path, not through this barrel;
 * it exists so a published-package consumer can still get at them explicitly.)
 */

// RICE codec.
export { riceDecompress, BitReader } from './rice/index.js';

// fpack file parsing, low-level tile decoders, the decoded-tile cache, and the
// engine behind the `TilePyramid` façade.
export { FpackFile } from './fpack/fpack-file.js';
export type { CompressionType, TileDecodeParams } from './fpack/fpack-file.js';
export { decodeRiceTile } from './fpack/decode-rice.js';
export { decodeGzip2Tile, gunzip } from './fpack/decode-gzip2.js';
export { LRUCache } from './lru.js';
export { TileEngine } from './fpack/tile-source.js';
export type { TileEngineOptions } from './fpack/tile-source.js';

// Persistent compressed-tile (disk) cache: interface + pure helpers + the
// IndexedDB-backed default, plus dynamic sizing/durability.
export type { BlobStore, DiskEntry } from './fpack/blob-store.js';
export {
  tileBlobKey,
  fingerprintManifest,
  fnv1aHex,
  selectDiskEvictions,
} from './fpack/blob-store.js';
export { openDefaultBlobStore } from './fpack/idb-blob-store.js';
export {
  resolveDiskBudget,
  requestPersistentStorage,
  DEFAULT_DISK_CACHE_CAP_BYTES,
  DISK_CACHE_QUOTA_FRACTION,
} from './fpack/cache-size.js';

// Worker glue: the stateless decode worker + the decode executors (inline / pool).
export { attachDecodeWorker } from './worker.js';
export type { WorkerLike, WorkerReply, WorkerRequest } from './fpack/worker-protocol.js';
export { inlineDecoder, WorkerPoolDecoder } from './fpack/decode-executor.js';
export type { DecodeExecutor } from './fpack/decode-executor.js';

// GPU tile management + the pure tile-selection helpers.
export {
  TileManager,
  targetLevel,
  visibleTiles,
  coarserFallback,
  commonResidentLevel,
  selectEvictions,
  buildLevelGeoms,
  tileWorldRect,
  tilePixelDims,
  fallbackUV,
  tileKey,
  TILE_SIZE,
} from './renderer/index.js';
export type { TileCoord, WorldRect, LevelGeom, EvictionEntry } from './renderer/index.js';

// Render-source internals + the authoritative same-grid gate.
export {
  isRenderSource,
  normalizeSource,
  manifestGridSpec,
  geomsEqual,
  isCompatibleGrid,
} from './renderer/index.js';
export type { NormalizedSource } from './renderer/index.js';
export { gridsMatch, GRID_MATCH_SUBPIXEL_FRACTION } from './wcs/index.js';
export type { GridSpec } from './wcs/index.js';

// Dataset grid-spec helper (returns the internal `GridSpec`).
export { bandGridSpec } from './dataset.js';
