/**
 * Shared message protocol for the decode worker pool (plan P4, "Shape B"). Pure
 * types + constants only, so the main-thread coordinator (`tile-source.ts`,
 * `decode-executor.ts`) and the worker entry (`worker.ts`) can depend on it
 * without a circular import.
 *
 * Workers are STATELESS decode units: the main thread owns the manifest, file
 * metadata, fetch, and the RAM/disk caches, and hands a worker only a tile's
 * compressed bytes + decode params. The worker returns the decoded floats.
 */

import type { TileDecodeParams } from './fpack-file.js';

/** Default decoded-tile (RAM) LRU capacity, used by `TileEngine`. */
export const DEFAULT_CACHE_SIZE = 256;

/** Main thread → decode worker. */
export type WorkerRequest =
  | { type: 'decode'; id: number; bytes: Uint8Array; params: TileDecodeParams }
  | { type: 'close' };

/** Decode worker → main thread. */
export type WorkerReply =
  | { type: 'decoded'; id: number; buffer: ArrayBuffer }
  | { type: 'decodeError'; id: number; error: string };

/** The subset of the main-thread `Worker` interface this library uses. */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

/** The subset of a worker global scope (`self`) this library uses. */
export interface WorkerScopeLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
}
