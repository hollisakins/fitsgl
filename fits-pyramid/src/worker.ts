/**
 * Web Worker entry for the tile pyramid.
 *
 * The worker hosts a {@link TileEngine}: it loads the manifest, opens fpack
 * files, decodes tiles, and caches them. Decoded `Float32Array`s are returned to
 * the main thread by *transferring* a clone of the buffer (the engine keeps its
 * cached copy, which a transfer would otherwise detach).
 *
 * `attachTileWorker` is transport-agnostic so the exact protocol can be unit
 * tested in Node against an in-process scope; the bottom of the file wires it to
 * the real worker global only when actually running inside a worker.
 */

import { TileEngine, type TileEngineOptions } from './fpack/tile-source.js';
import type { WorkerRequest, WorkerScopeLike } from './fpack/worker-protocol.js';

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Wire a worker scope's message handler to a TileEngine. */
export function attachTileWorker(scope: WorkerScopeLike, options: TileEngineOptions = {}): void {
  let engine: TileEngine | null = null;

  scope.onmessage = (ev: { data: unknown }): void => {
    void handle(ev.data as WorkerRequest);
  };

  async function handle(req: WorkerRequest): Promise<void> {
    switch (req.type) {
      case 'init':
        try {
          engine = await TileEngine.load(req.manifestUrl, { ...options, cacheSize: req.cacheSize });
          scope.postMessage({ type: 'inited', manifest: engine.getManifest() });
        } catch (e) {
          scope.postMessage({ type: 'initError', error: errorMessage(e) });
        }
        break;

      case 'getTile':
        if (engine === null) {
          scope.postMessage({ type: 'error', id: req.id, error: 'worker received getTile before init' });
          return;
        }
        try {
          const tile = await engine.getTile(req.level, req.tileX, req.tileY);
          // Clone so transferring the buffer does not detach the engine's cached tile.
          const copy = tile.slice();
          scope.postMessage({ type: 'tile', id: req.id, buffer: copy.buffer }, [copy.buffer]);
        } catch (e) {
          scope.postMessage({ type: 'error', id: req.id, error: errorMessage(e) });
        }
        break;

      case 'close':
        engine = null;
        break;
    }
  }
}

// Auto-attach only when running inside an actual worker global scope.
// `importScripts` exists on WorkerGlobalScope but not on Window or in Node, so it
// is a reliable, lib-agnostic sniff that never throws on a missing global.
const maybeScope = globalThis as unknown as { importScripts?: unknown };
if (typeof maybeScope.importScripts === 'function') {
  attachTileWorker(globalThis as unknown as WorkerScopeLike);
}
