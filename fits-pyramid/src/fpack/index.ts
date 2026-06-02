/**
 * Phase 2b public surface: the fpack parser + tile fetcher.
 */

export { TilePyramid, TileEngine } from './tile-source.js';
export type { TilePyramidOptions, TileEngineOptions } from './tile-source.js';
export { FpackFile, httpRangeFetch } from './fpack-file.js';
export type { RangeFetcher, CompressionType } from './fpack-file.js';
export { decodeRiceTile } from './decode-rice.js';
export { decodeGzip2Tile, gunzip } from './decode-gzip2.js';
export { parseFitsHeader, FitsHeader, IncompleteHeaderError } from './fits-header.js';
export {
  parseBinTableLayout,
  tformByteWidth,
  readDescriptor,
  readFloat64BE,
} from './bintable.js';
export type { BinTableLayout, ColumnDef } from './bintable.js';
export { attachDecodeWorker } from '../worker.js';
export type { WorkerLike, WorkerScopeLike, WorkerRequest, WorkerReply } from './worker-protocol.js';
export { inlineDecoder, WorkerPoolDecoder } from './decode-executor.js';
export type { DecodeExecutor } from './decode-executor.js';
