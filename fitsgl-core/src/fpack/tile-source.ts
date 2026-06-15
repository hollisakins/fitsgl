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

import { loadManifest, resolveLevelUrl, resolveSupertile, type Manifest } from '../manifest.js';
import { LRUCache } from '../lru.js';
import { FpackFile, httpRangeFetch, type RangeFetcher } from './fpack-file.js';
import { tileBlobKey, fingerprintManifest, type BlobStore } from './blob-store.js';
import { openDefaultBlobStore } from './idb-blob-store.js';
import { type WorkerLike, DEFAULT_CACHE_SIZE } from './worker-protocol.js';
import { inlineDecoder, WorkerPoolDecoder, type DecodeExecutor } from './decode-executor.js';

/**
 * Whether `e` is an abort (from `AbortSignal`/`fetch` cancellation). Both throw a
 * `DOMException` named `'AbortError'`; we match by name to stay cross-environment.
 */
export function isAbortError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError';
}

export interface TileEngineOptions {
  /** fetch implementation for the manifest JSON (default: global fetch). */
  fetchImpl?: typeof fetch;
  /** range fetcher for the fpack files (default: httpRangeFetch). */
  rangeFetch?: RangeFetcher;
  /** decoded-tile (RAM) LRU capacity (default 256). */
  cacheSize?: number;
  /**
   * Persistent compressed-tile cache (the "disk" tier). `undefined` (default):
   * use IndexedDB when available, otherwise none. `null`: disable it. Inject a
   * custom implementation for tests or advanced hosts.
   */
  blobStore?: BlobStore | null;
  /**
   * Namespace for the disk cache, isolating this pyramid's tiles. Defaults to a
   * fingerprint of the manifest (see `fingerprintManifest`).
   */
  fingerprint?: string;
  /**
   * Where the CPU-bound decode runs. Defaults to `inlineDecoder` (the calling
   * thread). `TilePyramid` injects a `WorkerPoolDecoder` to parallelize decode
   * across workers while metadata/fetch/cache stay on the main thread.
   */
  decoder?: DecodeExecutor;
}

export class TileEngine {
  private readonly manifestUrl: string;
  private readonly manifest: Manifest;
  private readonly rangeFetch: RangeFetcher;
  /** One open `FpackFile` per supertile, keyed by its resolved URL. */
  private readonly files = new Map<string, Promise<FpackFile>>();
  private readonly cache: LRUCache<string, Float32Array>;
  private readonly inflight = new Map<string, Promise<Float32Array>>();
  /** Persistent compressed-tile (disk) tier, or null when disabled/unavailable. */
  private readonly blobStore: BlobStore | null;
  /** Disk-cache namespace for this pyramid. */
  private readonly fingerprint: string;
  /** Where decode runs (inline on this thread, or a worker pool). */
  private readonly decoder: DecodeExecutor;

  private constructor(
    manifestUrl: string,
    manifest: Manifest,
    rangeFetch: RangeFetcher,
    cacheSize: number,
    blobStore: BlobStore | null,
    fingerprint: string,
    decoder: DecodeExecutor,
  ) {
    this.manifestUrl = manifestUrl;
    this.manifest = manifest;
    this.rangeFetch = rangeFetch;
    this.cache = new LRUCache<string, Float32Array>(cacheSize);
    this.blobStore = blobStore;
    this.fingerprint = fingerprint;
    this.decoder = decoder;
  }

  static async load(manifestUrl: string, options: TileEngineOptions = {}): Promise<TileEngine> {
    const fetchImpl = options.fetchImpl ?? fetch;
    const manifest = await loadManifest(manifestUrl, fetchImpl);
    const fingerprint = options.fingerprint ?? fingerprintManifest(manifest);
    // undefined → construct the default (IndexedDB if available, else null);
    // an explicit value (including null to disable) is used as given.
    const blobStore =
      options.blobStore === undefined ? await openDefaultBlobStore() : options.blobStore;
    return new TileEngine(
      manifestUrl,
      manifest,
      options.rangeFetch ?? httpRangeFetch,
      options.cacheSize ?? DEFAULT_CACHE_SIZE,
      blobStore,
      fingerprint,
      options.decoder ?? inlineDecoder,
    );
  }

  getManifest(): Manifest {
    return this.manifest;
  }

  /**
   * Whether a supertile of level `z` covers global tile (tileX, tileY) — pure, no
   * IO. False for an out-of-grid tile AND for an in-grid tile that no supertile
   * paves (a gap: a band built on a shared grid it only partly covers, or a
   * survey's irregular corner, ships no all-NaN supertile there). Callers use it
   * to skip requesting a tile that will never resolve, instead of fetching it and
   * handling the `getTile` rejection every frame.
   */
  hasTile(level: number, tileX: number, tileY: number): boolean {
    const lvl = this.manifest.levels.find((l) => l.z === level);
    if (lvl === undefined) return false;
    return resolveSupertile(lvl, tileX, tileY) !== undefined;
  }

  /**
   * Resolve a global tile to the supertile file that holds it plus its
   * supertile-local coordinates, opening (and memoizing) that `FpackFile`. For a
   * v1 / single-supertile level this is the whole level file and local == global.
   */
  private async fileForTile(
    level: number,
    tileX: number,
    tileY: number,
  ): Promise<{ file: FpackFile; localX: number; localY: number }> {
    const lvl = this.manifest.levels.find((l) => l.z === level);
    if (lvl === undefined) {
      throw new Error(`TileEngine: no level z=${level} in manifest`);
    }
    const match = resolveSupertile(lvl, tileX, tileY);
    if (match === undefined) {
      throw new Error(
        `TileEngine: tile (${tileX}, ${tileY}) is out of range — no supertile of level z=${level} covers it`,
      );
    }
    const url = resolveLevelUrl(this.manifestUrl, match.supertile.filename);
    let opened = this.files.get(url);
    if (opened === undefined) {
      opened = FpackFile.open(url, this.rangeFetch);
      this.files.set(url, opened);
      // If opening fails, drop the cached rejected promise so a retry can re-open.
      opened.catch(() => this.files.delete(url));
    }
    const file = await opened;
    return { file, localX: match.localX, localY: match.localY };
  }

  async getTile(
    level: number,
    tileX: number,
    tileY: number,
    signal?: AbortSignal,
  ): Promise<Float32Array> {
    const key = `${level}/${tileX}/${tileY}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached; // cache hit is instant; signal moot
    const pending = this.inflight.get(key);
    // A deduped in-flight request shares the original caller's fetch (and its
    // abort fate); the new caller's signal is intentionally not rewired onto it.
    if (pending !== undefined) return pending;

    const promise = (async () => {
      // Resolve which supertile holds this global tile and its file-local coords;
      // every fpack read below is in the supertile's own grid.
      const { file, localX, localY } = await this.fileForTile(level, tileX, tileY);
      // Decode params come from the (cached) tile index; the compressed bytes come
      // from the disk tier when present, else the network. One decode path, fed by
      // {disk | network} — bit-identical either way.
      const params = await file.tileDecodeParams(localX, localY);
      const bytes = await this.compressedBytes(file, level, tileX, tileY, localX, localY, signal);
      // Cancelled mid-fetch? Don't spend a decode-pool slot on an abandoned tile.
      signal?.throwIfAborted();
      const tile = await this.decoder.decode(bytes, params);
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

  /**
   * The decoded tile if it is CURRENTLY RAM-resident, else `undefined` — a
   * synchronous, fetch-free, recency-preserving read. Unlike `getTile`, this
   * never touches the network/disk/decoder and never bumps the LRU (it uses
   * `cache.peek`), so it is safe to call at pointer-move frequency for a live
   * cursor value readout or a region peek. A miss means "not decoded yet", not
   * "absent" — call `getTile` to load it. The returned array is the cache's own
   * instance (same as `getTile`): read, don't mutate.
   */
  peekTile(level: number, tileX: number, tileY: number): Float32Array | undefined {
    return this.cache.peek(`${level}/${tileX}/${tileY}`);
  }

  /**
   * The tile's compressed bytes, served from the disk tier when it holds them and
   * written through on a miss. Disk get/put failures degrade to a plain network
   * fetch so a flaky/disabled store never breaks tile loading.
   */
  private async compressedBytes(
    file: FpackFile,
    level: number,
    tileX: number,
    tileY: number,
    localX: number,
    localY: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    // The blob-cache key is the GLOBAL (level, x, y) so it is stable across
    // supertile layouts; the fetch is in the file's LOCAL coords.
    if (this.blobStore === null) return file.fetchCompressedTile(localX, localY, signal);
    const blobKey = tileBlobKey(this.fingerprint, level, tileX, tileY);
    try {
      const hit = await this.blobStore.get(blobKey);
      if (hit !== undefined) return hit;
    } catch {
      // disk read failed — fall through to the network
    }
    const fetched = await file.fetchCompressedTile(localX, localY, signal);
    // Fire-and-forget write-through; never let a cache write fail a tile load.
    this.blobStore.put(blobKey, fetched).catch(() => undefined);
    return fetched;
  }

  /**
   * Speculatively warm a level's file + tile index without fetching or decoding a
   * tile — open the supertile that holds `(level, tileX, tileY)` and parse its
   * BINTABLE row table, both memoized. Used to hide the per-level first-touch
   * latency (file open + index parse) behind idle time, so a later `getTile` at
   * that level pays only the tile-bytes round trip. Best-effort: any error
   * (network blip, out-of-range tile) is swallowed and re-thrown to the caller is
   * avoided — `getTile` will re-open on demand, since `fileForTile` drops a failed
   * open from its memo. One warmed tile loads the whole level index for its
   * supertile.
   */
  async prefetchTileIndex(level: number, tileX: number, tileY: number): Promise<void> {
    try {
      const { file } = await this.fileForTile(level, tileX, tileY);
      await file.loadTileIndex();
    } catch {
      // Speculative: a failed warm-up costs nothing; the real getTile retries.
    }
  }

  /** Number of cached tiles (diagnostics/tests). */
  get cacheSize(): number {
    return this.cache.size;
  }

  /** Release the disk-cache connection and the decoder (worker pool), if any. */
  close(): void {
    this.blobStore?.close?.();
    this.decoder.close();
  }
}

/** Decode worker-pool size when not given: `min(4, hardwareConcurrency − 1)`. */
function defaultPoolSize(): number {
  const hc =
    typeof navigator !== 'undefined' && typeof navigator.hardwareConcurrency === 'number'
      ? navigator.hardwareConcurrency
      : 4;
  return Math.max(1, Math.min(4, hc - 1));
}

export interface TilePyramidOptions extends TileEngineOptions {
  /**
   * Use a decode worker pool. Default: yes when `Worker` is available (or a
   * `workerFactory` is given) and no custom fetchers are injected. Decode is the
   * only thing offloaded — fetch and the caches stay on the main thread — but the
   * default still skips the pool when fetchers are injected so the demo/tests keep
   * their single-threaded, byte-observable path unless they opt in with `true`.
   */
  useWorker?: boolean;
  /** Factory for one decode worker (default: a module Web Worker). For tests. */
  workerFactory?: () => WorkerLike;
  /** Decode worker-pool size (default: `min(4, hardwareConcurrency − 1)`). */
  poolSize?: number;
}

/**
 * Public façade over a `TileEngine` (plan P4, "Shape B"). The engine — manifest,
 * file metadata, fetch, RAM + disk caches, de-dup — always runs on the main
 * thread; the only difference between modes is the engine's decode executor:
 * inline (single-threaded) or a `WorkerPoolDecoder` that parallelizes decode
 * across stateless workers. So this class is a thin wrapper; the previous
 * worker-side engine + main-side request bookkeeping collapse into the engine.
 */
export class TilePyramid {
  private readonly engine: TileEngine;
  private destroyed = false;

  private constructor(engine: TileEngine) {
    this.engine = engine;
  }

  static async load(manifestUrl: string, options: TilePyramidOptions = {}): Promise<TilePyramid> {
    const canPool = options.workerFactory !== undefined || typeof Worker !== 'undefined';
    const injectedFetchers = options.rangeFetch !== undefined || options.fetchImpl !== undefined;
    const usePool = (options.useWorker ?? (canPool && !injectedFetchers)) && canPool;

    if (!usePool) {
      const engine = await TileEngine.load(manifestUrl, options);
      return new TilePyramid(engine);
    }

    const factory =
      options.workerFactory ??
      ((): WorkerLike =>
        new Worker(new URL('../worker.js', import.meta.url), { type: 'module' }) as WorkerLike);
    const pool = new WorkerPoolDecoder(options.poolSize ?? defaultPoolSize(), factory);
    try {
      const engine = await TileEngine.load(manifestUrl, { ...options, decoder: pool });
      return new TilePyramid(engine);
    } catch (e) {
      // load() never returns the pyramid on failure, so the caller can't call
      // destroy(); tear the pool's workers down here to avoid leaking threads.
      pool.close();
      throw e;
    }
  }

  getManifest(): Manifest {
    return this.engine.getManifest();
  }

  /** Whether a supertile of level `z` covers (tileX, tileY); see `TileEngine.hasTile`. */
  hasTile(level: number, tileX: number, tileY: number): boolean {
    if (this.destroyed) return false;
    return this.engine.hasTile(level, tileX, tileY);
  }

  async getTile(
    level: number,
    tileX: number,
    tileY: number,
    signal?: AbortSignal,
  ): Promise<Float32Array> {
    if (this.destroyed) throw new Error('TilePyramid: getTile called after destroy()');
    return this.engine.getTile(level, tileX, tileY, signal);
  }

  /**
   * The decoded tile if RAM-resident, else `undefined` — synchronous, fetch-free,
   * non-LRU-bumping. The cheap read path for a live cursor value readout (the tile
   * the renderer just drew is resident, so the peek is an instant hit). See
   * `TileEngine.peekTile`. Returns `undefined` after `destroy()`.
   */
  peekTile(level: number, tileX: number, tileY: number): Float32Array | undefined {
    if (this.destroyed) return undefined;
    return this.engine.peekTile(level, tileX, tileY);
  }

  /**
   * Speculatively warm a level's file + tile index (no tile fetch/decode), so a
   * later `getTile` at that level pays only the tile-bytes round trip rather than
   * the file-open + index-parse round trips on top. Best-effort and silent; a no-op
   * after `destroy()`. See `TileEngine.prefetchTileIndex`.
   */
  async prefetchTileIndex(level: number, tileX: number, tileY: number): Promise<void> {
    if (this.destroyed) return;
    return this.engine.prefetchTileIndex(level, tileX, tileY);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.engine.close(); // closes the disk cache + the decode worker pool
  }
}
