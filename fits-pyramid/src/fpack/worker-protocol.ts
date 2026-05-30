/**
 * Shared message protocol for the tile Web Worker. Pure types + constants only,
 * so both the main-thread façade (`tile-source.ts`) and the worker entry
 * (`worker.ts`) can depend on it without a circular import.
 */

import type { Manifest } from '../manifest.js';

export const DEFAULT_CACHE_SIZE = 256;

/** Main thread → worker. */
export type WorkerRequest =
  | { type: 'init'; manifestUrl: string; cacheSize: number }
  | { type: 'getTile'; id: number; level: number; tileX: number; tileY: number }
  | { type: 'close' };

/** Worker → main thread. */
export type WorkerReply =
  | { type: 'inited'; manifest: Manifest }
  | { type: 'initError'; error: string }
  | { type: 'tile'; id: number; buffer: ArrayBuffer }
  | { type: 'error'; id: number; error: string };

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
