/**
 * High-level tile access.
 *
 * `TileEngine` does the real work: load the manifest, lazily open one
 * `FpackFile` per level, decode tiles, and cache decoded `Float32Array`s in an
 * LRU with in-flight de-duplication of concurrent identical requests. It has no
 * dependency on Web Workers, so it is exercised directly by the tests.
 *
 * `TilePyramid` is the public façade. In a browser it offloads a `TileEngine`
 * into a Web Worker (so all fetching/parsing/decompression happens off the main
 * thread, and only transferred `Float32Array`s cross back); without a worker —
 * Node, tests, or `{ useWorker: false }` — it drives a `TileEngine` inline. Both
 * modes present the identical async `getTile` contract.
 */

import { loadManifest, resolveLevelUrl, type Manifest } from '../manifest.js';
import { LRUCache } from '../lru.js';
import { FpackFile, httpRangeFetch, type RangeFetcher } from './fpack-file.js';
import {
  type WorkerLike,
  type WorkerReply,
  DEFAULT_CACHE_SIZE,
} from './worker-protocol.js';

export interface TileEngineOptions {
  /** fetch implementation for the manifest JSON (default: global fetch). */
  fetchImpl?: typeof fetch;
  /** range fetcher for the fpack files (default: httpRangeFetch). */
  rangeFetch?: RangeFetcher;
  /** decoded-tile LRU capacity (default 256). */
  cacheSize?: number;
}

export class TileEngine {
  private readonly manifestUrl: string;
  private readonly manifest: Manifest;
  private readonly rangeFetch: RangeFetcher;
  private readonly files = new Map<number, Promise<FpackFile>>();
  private readonly cache: LRUCache<string, Float32Array>;
  private readonly inflight = new Map<string, Promise<Float32Array>>();

  private constructor(manifestUrl: string, manifest: Manifest, rangeFetch: RangeFetcher, cacheSize: number) {
    this.manifestUrl = manifestUrl;
    this.manifest = manifest;
    this.rangeFetch = rangeFetch;
    this.cache = new LRUCache<string, Float32Array>(cacheSize);
  }

  static async load(manifestUrl: string, options: TileEngineOptions = {}): Promise<TileEngine> {
    const fetchImpl = options.fetchImpl ?? fetch;
    const manifest = await loadManifest(manifestUrl, fetchImpl);
    return new TileEngine(
      manifestUrl,
      manifest,
      options.rangeFetch ?? httpRangeFetch,
      options.cacheSize ?? DEFAULT_CACHE_SIZE,
    );
  }

  getManifest(): Manifest {
    return this.manifest;
  }

  private fileForLevel(level: number): Promise<FpackFile> {
    const existing = this.files.get(level);
    if (existing !== undefined) return existing;
    const lvl = this.manifest.levels.find((l) => l.z === level);
    if (lvl === undefined) {
      return Promise.reject(new Error(`TileEngine: no level z=${level} in manifest`));
    }
    const url = resolveLevelUrl(this.manifestUrl, lvl.filename);
    const opened = FpackFile.open(url, this.rangeFetch);
    this.files.set(level, opened);
    // If opening fails, drop the cached rejected promise so a retry can re-open.
    opened.catch(() => this.files.delete(level));
    return opened;
  }

  async getTile(level: number, tileX: number, tileY: number): Promise<Float32Array> {
    const key = `${level}/${tileX}/${tileY}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const pending = this.inflight.get(key);
    if (pending !== undefined) return pending;

    const promise = (async () => {
      const file = await this.fileForLevel(level);
      const tile = await file.getTile(tileX, tileY);
      this.cache.set(key, tile);
      return tile;
    })();
    this.inflight.set(key, promise);
    try {
      return await promise;
    } finally {
      this.inflight.delete(key);
    }
  }

  /** Number of cached tiles (diagnostics/tests). */
  get cacheSize(): number {
    return this.cache.size;
  }
}

export interface TilePyramidOptions extends TileEngineOptions {
  /**
   * Force worker on/off. Default: use a worker when `Worker` is available and no
   * custom fetchers are injected (closures cannot cross a real worker boundary).
   */
  useWorker?: boolean;
  /** Factory for the worker (default: a module Web Worker). Injectable for tests. */
  workerFactory?: () => WorkerLike;
}

interface PendingRequest {
  resolve: (value: Float32Array) => void;
  reject: (reason: Error) => void;
}

export class TilePyramid {
  private readonly engine: TileEngine | null;
  private readonly worker: WorkerLike | null;
  private manifest: Manifest;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly inflight = new Map<string, Promise<Float32Array>>();
  private nextId = 1;
  private destroyed = false;

  private constructor(manifest: Manifest, engine: TileEngine | null, worker: WorkerLike | null) {
    this.manifest = manifest;
    this.engine = engine;
    this.worker = worker;
  }

  static async load(manifestUrl: string, options: TilePyramidOptions = {}): Promise<TilePyramid> {
    const hasWorkerGlobal = typeof Worker !== 'undefined';
    const injectedFetchers = options.rangeFetch !== undefined || options.fetchImpl !== undefined;
    const useWorker =
      options.useWorker ??
      ((options.workerFactory !== undefined || hasWorkerGlobal) && !injectedFetchers);

    if (!useWorker) {
      const engine = await TileEngine.load(manifestUrl, options);
      return new TilePyramid(engine.getManifest(), engine, null);
    }

    const worker =
      options.workerFactory !== undefined
        ? options.workerFactory()
        : (new Worker(new URL('../worker.js', import.meta.url), { type: 'module' }) as WorkerLike);

    const pyramid = new TilePyramid(
      { version: 0, source_file: '', native_shape: [0, 0], fpack_tile_size: 0, n_levels: 0, levels: [] },
      null,
      worker,
    );
    worker.onmessage = (ev: { data: unknown }) => pyramid.onWorkerMessage(ev.data as WorkerReply);

    try {
      pyramid.manifest = await new Promise<Manifest>((resolve, reject) => {
        pyramid.initResolve = resolve;
        pyramid.initReject = reject;
        worker.postMessage({
          type: 'init',
          manifestUrl,
          cacheSize: options.cacheSize ?? DEFAULT_CACHE_SIZE,
        });
      });
    } catch (e) {
      // load() never returns the pyramid on failure, so the caller can't call
      // destroy(); tear the worker down here to avoid leaking a worker thread.
      worker.onmessage = null;
      worker.terminate();
      throw e;
    }
    return pyramid;
  }

  private initResolve: ((m: Manifest) => void) | null = null;
  private initReject: ((e: Error) => void) | null = null;

  private onWorkerMessage(reply: WorkerReply): void {
    switch (reply.type) {
      case 'inited':
        this.initResolve?.(reply.manifest);
        this.initResolve = this.initReject = null;
        break;
      case 'initError':
        this.initReject?.(new Error(reply.error));
        this.initResolve = this.initReject = null;
        break;
      case 'tile': {
        const req = this.pending.get(reply.id);
        if (req !== undefined) {
          this.pending.delete(reply.id);
          req.resolve(new Float32Array(reply.buffer));
        }
        break;
      }
      case 'error': {
        const req = this.pending.get(reply.id);
        if (req !== undefined) {
          this.pending.delete(reply.id);
          req.reject(new Error(reply.error));
        }
        break;
      }
    }
  }

  getManifest(): Manifest {
    return this.manifest;
  }

  async getTile(level: number, tileX: number, tileY: number): Promise<Float32Array> {
    if (this.destroyed) throw new Error('TilePyramid: getTile called after destroy()');
    if (this.engine !== null) return this.engine.getTile(level, tileX, tileY);

    // Worker mode: de-duplicate concurrent identical requests on the main side.
    const key = `${level}/${tileX}/${tileY}`;
    const existing = this.inflight.get(key);
    if (existing !== undefined) return existing;

    const worker = this.worker!;
    const id = this.nextId++;
    const promise = new Promise<Float32Array>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ type: 'getTile', id, level, tileX, tileY });
    });
    this.inflight.set(key, promise);
    try {
      return await promise;
    } finally {
      this.inflight.delete(key);
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.worker !== null) {
      this.worker.postMessage({ type: 'close' });
      this.worker.terminate();
      this.worker.onmessage = null;
    }
    for (const req of this.pending.values()) {
      req.reject(new Error('TilePyramid destroyed'));
    }
    this.pending.clear();
    this.inflight.clear();
  }
}
