/**
 * Web Worker entry: a STATELESS tile-decode service (plan P4, "Shape B").
 *
 * The main thread owns the manifest, file metadata, fetch, and the RAM/disk
 * caches; it hands a worker only a tile's compressed bytes + decode params. The
 * worker decodes (the CPU-bound RICE/GZIP step) and transfers the resulting
 * Float32Array buffer back. No manifest, no fetching, no caching here — so a
 * pool of these parallelizes decode across cores.
 *
 * `attachDecodeWorker` is transport-agnostic so the protocol can be unit-tested
 * in Node against an in-process scope; the bottom wires it to the real worker
 * global only when actually running inside a worker.
 */

import { FpackFile } from './fpack/fpack-file.js';
import type { WorkerRequest, WorkerScopeLike } from './fpack/worker-protocol.js';

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Wire a worker scope's message handler to the stateless decode service. */
export function attachDecodeWorker(scope: WorkerScopeLike): void {
  scope.onmessage = (ev: { data: unknown }): void => {
    void handle(ev.data as WorkerRequest);
  };

  async function handle(req: WorkerRequest): Promise<void> {
    if (req.type !== 'decode') return; // 'close': stateless, nothing to tear down
    try {
      const floats = await FpackFile.decodeTile(req.bytes, req.params);
      // The decoded buffer is freshly allocated per tile, so transferring it is safe.
      scope.postMessage({ type: 'decoded', id: req.id, buffer: floats.buffer }, [floats.buffer]);
    } catch (e) {
      scope.postMessage({ type: 'decodeError', id: req.id, error: errorMessage(e) });
    }
  }
}

// Auto-attach only when running inside an actual worker global scope.
// `importScripts` exists on WorkerGlobalScope but not on Window or in Node, so it
// is a reliable, lib-agnostic sniff that never throws on a missing global.
const maybeScope = globalThis as unknown as { importScripts?: unknown };
if (typeof maybeScope.importScripts === 'function') {
  attachDecodeWorker(globalThis as unknown as WorkerScopeLike);
}
