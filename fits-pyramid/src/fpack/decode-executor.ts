/**
 * Decode executor — the pluggable CPU step of the tile pipeline (plan P4).
 *
 * The `TileEngine` core (manifest, file metadata, fetch, RAM + disk caches,
 * de-dup) runs on the main thread; only the CPU-bound RICE/GZIP decode is
 * offloaded. `inlineDecoder` decodes on the calling thread (Node, tests, the
 * demo, or a single-threaded fallback). `WorkerPoolDecoder` round-robins decode
 * jobs across N stateless decode workers so a viewport burst — or a warm
 * reload served from disk — decodes in parallel instead of serially.
 */

import { FpackFile, type TileDecodeParams } from './fpack-file.js';
import type { WorkerLike, WorkerReply } from './worker-protocol.js';

export interface DecodeExecutor {
  /** Decode a tile's compressed bytes to a Float32Array. */
  decode(bytes: Uint8Array, params: TileDecodeParams): Promise<Float32Array>;
  /** Release any workers/resources. */
  close(): void;
}

/** Decode on the calling thread. Stateless; `close` is a no-op (safe to share). */
export const inlineDecoder: DecodeExecutor = {
  decode: (bytes, params) => FpackFile.decodeTile(bytes, params),
  close: () => {},
};

interface Pending {
  resolve: (value: Float32Array) => void;
  reject: (reason: Error) => void;
}

/**
 * Round-robins decode jobs across N stateless decode workers. Replies are keyed
 * by a globally-unique id, so any worker's reply resolves the right job; routing
 * only balances load (workers hold no state, so any worker can decode any tile).
 */
export class WorkerPoolDecoder implements DecodeExecutor {
  private readonly workers: WorkerLike[] = [];
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private cursor = 0;
  private closed = false;

  constructor(size: number, factory: () => WorkerLike) {
    const n = Math.max(1, Math.floor(size));
    for (let i = 0; i < n; i++) {
      const w = factory();
      w.onmessage = (ev: { data: unknown }): void => this.onReply(ev.data as WorkerReply);
      this.workers.push(w);
    }
  }

  /** Number of workers in the pool (diagnostics/tests). */
  get size(): number {
    return this.workers.length;
  }

  decode(bytes: Uint8Array, params: TileDecodeParams): Promise<Float32Array> {
    if (this.closed) return Promise.reject(new Error('WorkerPoolDecoder: decode after close()'));
    const id = this.nextId++;
    const worker = this.workers[this.cursor++ % this.workers.length]!;
    return new Promise<Float32Array>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      // Clone the compressed bytes (structured clone); do NOT transfer — the
      // disk write-through may still reference `bytes`. The decoded result buffer
      // is transferred back by the worker.
      worker.postMessage({ type: 'decode', id, bytes, params });
    });
  }

  private onReply(reply: WorkerReply): void {
    const p = this.pending.get(reply.id);
    if (p === undefined) return;
    this.pending.delete(reply.id);
    if (reply.type === 'decoded') p.resolve(new Float32Array(reply.buffer));
    else p.reject(new Error(reply.error));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.workers) {
      try {
        w.postMessage({ type: 'close' });
      } catch {
        // ignore — terminating anyway
      }
      w.terminate();
      w.onmessage = null;
    }
    for (const p of this.pending.values()) p.reject(new Error('WorkerPoolDecoder closed'));
    this.pending.clear();
  }
}
