import { describe, it, expect } from 'vitest';
import { TilePyramid, TileEngine, isAbortError, type TilePyramidOptions } from '../src/fpack/tile-source.js';
import type { BlobStore } from '../src/fpack/blob-store.js';
import type { RangeFetcher } from '../src/fpack/fpack-file.js';
import {
  MANIFEST_URL,
  manifestFetch,
  fixtureRangeFetcher,
  createInProcessWorker,
  createMemoryBlobStore,
  readFixtureFloat32,
  sliceTile,
  firstFloatMismatch,
  CHUNKED_MANIFEST_URL,
  chunkedManifestFetch,
  chunkedRangeFetcher,
  readChunkedFloat32,
  firstUlpMismatch,
} from './helpers.js';

const native = readFixtureFloat32('native.bin');
const z1Decoded = readFixtureFloat32('z1_decoded.bin');

function inlineOptions() {
  return { useWorker: false as const, fetchImpl: manifestFetch(), rangeFetch: fixtureRangeFetcher().fetch };
}

describe('TilePyramid (inline engine)', () => {
  it('loads the manifest and exposes its levels', async () => {
    const p = await TilePyramid.load(MANIFEST_URL, inlineOptions());
    const m = p.getManifest();
    expect(m.n_levels).toBe(1);
    expect(m.levels.map((l) => l.compression)).toEqual(['GZIP_2', 'RICE_1']);
    expect(m.native_shape).toEqual([512, 512]);
    p.destroy();
  });

  it('getTile(0,…) returns lossless float32 from the GZIP_2 level', async () => {
    const p = await TilePyramid.load(MANIFEST_URL, inlineOptions());
    const tile = await p.getTile(0, 1, 1); // bottom-right tile
    const expectedTile = sliceTile(native, 512, 1, 1, 256, 256);
    expect(firstFloatMismatch(tile, expectedTile, 0)).toBe(-1);
    p.destroy();
  });

  it('getTile(1,…) returns the RICE_1 tile matching astropy', async () => {
    const p = await TilePyramid.load(MANIFEST_URL, inlineOptions());
    const tile = await p.getTile(1, 0, 0);
    expect(firstFloatMismatch(tile, z1Decoded, 0)).toBe(-1);
    p.destroy();
  });

  it('end-to-end GZIP_2 lossless guarantee: every z=0 tile reconstructs the native image exactly', async () => {
    const p = await TilePyramid.load(MANIFEST_URL, inlineOptions());
    const recon = new Float32Array(512 * 512);
    for (let ty = 0; ty < 2; ty++) {
      for (let tx = 0; tx < 2; tx++) {
        const tile = await p.getTile(0, tx, ty);
        for (let r = 0; r < 256; r++) {
          for (let c = 0; c < 256; c++) {
            recon[(ty * 256 + r) * 512 + (tx * 256 + c)] = tile[r * 256 + c]!;
          }
        }
      }
    }
    expect(firstFloatMismatch(recon, native, 0)).toBe(-1);
    p.destroy();
  });
});

describe('TilePyramid — chunked level (v2 supertiles, real cross-language fixture)', () => {
  // The chunked fixture is built by the Python pipeline with supertile_blocks=1, so
  // z=0 (a 2×2 tile grid) is split across four single-tile .fits.fz files. This is
  // the end-to-end proof that the client resolves a global tile to the right
  // supertile + local coords AND decodes a real emitter-produced supertile.
  function chunkedOptions() {
    return {
      useWorker: false as const,
      fetchImpl: chunkedManifestFetch(),
      rangeFetch: chunkedRangeFetcher().fetch,
      blobStore: null,
    };
  }

  it('parses the v2 manifest: z=0 is four supertiles, z=1 one', async () => {
    const p = await TilePyramid.load(CHUNKED_MANIFEST_URL, chunkedOptions());
    const m = p.getManifest();
    expect(m.version).toBe(2);
    expect(m.levels[0]!.supertiles.length).toBe(4);
    expect(m.levels[1]!.supertiles.length).toBe(1);
    expect(m.levels[0]!.fpack_tile_count).toEqual([2, 2]); // total grid intact
    p.destroy();
  });

  it('routes global tile (1,1) to its supertile and decodes it bit-for-bit vs astropy', async () => {
    const rf = chunkedRangeFetcher();
    const p = await TilePyramid.load(CHUNKED_MANIFEST_URL, { ...chunkedOptions(), rangeFetch: rf.fetch });
    // Global tile (1,1) lives in the supertile at tile_origin [1,1], local (0,0).
    const tile = await p.getTile(0, 1, 1);
    const expected = readChunkedFloat32('z0_1_1_decoded.bin'); // astropy's q8 decode
    // RICE+SUBTRACTIVE_DITHER_2 matches astropy to ≤1 ULP (the FMA tolerance).
    expect(firstUlpMismatch(tile, expected, 1)).toBe(-1);
    // It fetched from the (1,1) supertile file, not another supertile.
    expect(rf.calls.some((c) => c.name === 'synthetic_z0_1_1.fits.fz')).toBe(true);
    expect(rf.calls.some((c) => c.name === 'synthetic_z0_0_0.fits.fz')).toBe(false);
    p.destroy();
  });

  it('an out-of-grid tile rejects (no supertile covers it)', async () => {
    const p = await TilePyramid.load(CHUNKED_MANIFEST_URL, chunkedOptions());
    await expect(p.getTile(0, 5, 5)).rejects.toThrow(/out of range/i);
    p.destroy();
  });
});

describe('TileEngine — caching and de-duplication', () => {
  it('LRU evicts past capacity', async () => {
    const engine = await TileEngine.load(MANIFEST_URL, {
      fetchImpl: manifestFetch(),
      rangeFetch: fixtureRangeFetcher().fetch,
      cacheSize: 2,
    });
    await engine.getTile(0, 0, 0);
    await engine.getTile(0, 1, 0);
    expect(engine.cacheSize).toBe(2);
    await engine.getTile(0, 0, 1); // third distinct tile → eviction keeps size at 2
    expect(engine.cacheSize).toBe(2);
  });

  it('concurrent identical requests dedupe to one fetch+decode', async () => {
    const rf = fixtureRangeFetcher();
    const engine = await TileEngine.load(MANIFEST_URL, { fetchImpl: manifestFetch(), rangeFetch: rf.fetch });
    const results = await Promise.all(
      Array.from({ length: 6 }, () => engine.getTile(0, 0, 0)),
    );
    // All callers receive the very same decoded array instance.
    for (const r of results) expect(r).toBe(results[0]);
    // The tile's heap bytes (offset >= heapStart 8672) were fetched exactly once.
    const heapFetches = rf.calls.filter((c) => c.name === 'synthetic_z0.fits.fz' && c.start >= 8672);
    expect(heapFetches.length).toBe(1);
  });

  it('a second request for a cached tile does not refetch', async () => {
    const rf = fixtureRangeFetcher();
    const engine = await TileEngine.load(MANIFEST_URL, { fetchImpl: manifestFetch(), rangeFetch: rf.fetch });
    const a = await engine.getTile(1, 0, 0);
    const callsAfterFirst = rf.calls.length;
    const b = await engine.getTile(1, 0, 0);
    expect(b).toBe(a);
    expect(rf.calls.length).toBe(callsAfterFirst); // served from cache
  });

  it('prefetchTileIndex warms the file+index so a later getTile only fetches tile bytes', async () => {
    const rf = fixtureRangeFetcher();
    const engine = await TileEngine.load(MANIFEST_URL, {
      fetchImpl: manifestFetch(),
      rangeFetch: rf.fetch,
      blobStore: null,
    });
    await engine.prefetchTileIndex(1, 0, 0);
    const callsAfterWarm = rf.calls.length;
    expect(callsAfterWarm).toBeGreaterThan(0); // the warm opened the file (+ index)

    const tile = await engine.getTile(1, 0, 0);
    const added = rf.calls.slice(callsAfterWarm);
    // getTile re-opened nothing (no fetch at offset 0); it only fetched tile heap
    // bytes — so the per-level open + index round trips were paid by the warm-up.
    expect(added.length).toBeGreaterThan(0);
    expect(added.every((c) => c.start > 0)).toBe(true);
    expect(firstFloatMismatch(tile, z1Decoded, 0)).toBe(-1); // and the tile is correct
  });

  it('prefetchTileIndex is best-effort: an out-of-range tile resolves without throwing', async () => {
    const engine = await TileEngine.load(MANIFEST_URL, {
      fetchImpl: manifestFetch(),
      rangeFetch: fixtureRangeFetcher().fetch,
      blobStore: null,
    });
    await expect(engine.prefetchTileIndex(0, 99, 99)).resolves.toBeUndefined();
  });
});

describe('TileEngine / TilePyramid — peekTile (synchronous, fetch-free RAM read)', () => {
  it('returns undefined for a tile that has not been loaded (no fetch triggered)', async () => {
    const rf = fixtureRangeFetcher();
    const engine = await TileEngine.load(MANIFEST_URL, {
      fetchImpl: manifestFetch(),
      rangeFetch: rf.fetch,
      blobStore: null,
    });
    const callsBefore = rf.calls.length;
    expect(engine.peekTile(1, 0, 0)).toBeUndefined();
    expect(rf.calls.length).toBe(callsBefore); // a peek must never fetch
  });

  it('returns the decoded array once the tile is resident (same instance as getTile)', async () => {
    const engine = await TileEngine.load(MANIFEST_URL, {
      fetchImpl: manifestFetch(),
      rangeFetch: fixtureRangeFetcher().fetch,
      blobStore: null,
    });
    const loaded = await engine.getTile(1, 0, 0);
    const peeked = engine.peekTile(1, 0, 0);
    expect(peeked).toBe(loaded); // the cache's own instance
    expect(firstFloatMismatch(peeked!, z1Decoded, 0)).toBe(-1);
  });

  it('does not bump LRU recency, so a peeked tile is still evicted as the oldest', async () => {
    const engine = await TileEngine.load(MANIFEST_URL, {
      fetchImpl: manifestFetch(),
      rangeFetch: fixtureRangeFetcher().fetch,
      cacheSize: 2,
      blobStore: null,
    });
    await engine.getTile(0, 0, 0); // oldest
    await engine.getTile(0, 1, 0);
    engine.peekTile(0, 0, 0); // read without bumping recency
    await engine.getTile(0, 0, 1); // third distinct tile → evicts the still-oldest (0,0,0)
    expect(engine.peekTile(0, 0, 0)).toBeUndefined();
    expect(engine.cacheSize).toBe(2);
  });

  it('TilePyramid facade peeks resident tiles and returns undefined after destroy()', async () => {
    const p = await TilePyramid.load(MANIFEST_URL, inlineOptions());
    expect(p.peekTile(1, 0, 0)).toBeUndefined(); // not loaded yet
    const loaded = await p.getTile(1, 0, 0);
    expect(p.peekTile(1, 0, 0)).toBe(loaded);
    p.destroy();
    expect(p.peekTile(1, 0, 0)).toBeUndefined(); // no throw after destroy
  });
});

describe('TilePyramid (decode worker-pool mode, in-process workers)', () => {
  // The main-thread TileEngine owns manifest/fetch/cache; the pool only decodes.
  // So fetchers go to the pyramid (main side), and the in-process workers are
  // stateless decode units created by the factory.
  function poolOptions(
    workers: Array<ReturnType<typeof createInProcessWorker>>,
    extra: Partial<TilePyramidOptions> = {},
  ): TilePyramidOptions {
    return {
      useWorker: true,
      poolSize: 2,
      workerFactory: () => {
        const w = createInProcessWorker();
        workers.push(w);
        return w;
      },
      rangeFetch: fixtureRangeFetcher().fetch,
      fetchImpl: manifestFetch(),
      blobStore: null,
      ...extra,
    };
  }

  it('decodes through the worker pool and returns correct tiles', async () => {
    const workers: Array<ReturnType<typeof createInProcessWorker>> = [];
    const p = await TilePyramid.load(MANIFEST_URL, poolOptions(workers));
    expect(p.getManifest().n_levels).toBe(1);
    expect(workers.length).toBe(2);

    const g = await p.getTile(0, 0, 0);
    expect(firstFloatMismatch(g, sliceTile(native, 512, 0, 0, 256, 256), 0)).toBe(-1);
    const r = await p.getTile(1, 0, 0);
    expect(firstFloatMismatch(r, z1Decoded, 0)).toBe(-1);
    p.destroy();
  });

  it('dedupes concurrent identical requests (one decode) in the main-thread engine', async () => {
    const workers: Array<ReturnType<typeof createInProcessWorker>> = [];
    const p = await TilePyramid.load(MANIFEST_URL, poolOptions(workers));
    const results = await Promise.all(Array.from({ length: 5 }, () => p.getTile(0, 1, 0)));
    const expectedTile = sliceTile(native, 512, 1, 0, 256, 256);
    for (const r of results) expect(firstFloatMismatch(r, expectedTile, 0)).toBe(-1);
    p.destroy();
  });

  it('destroy() terminates all pool workers and rejects later getTile calls', async () => {
    const workers: Array<ReturnType<typeof createInProcessWorker>> = [];
    const p = await TilePyramid.load(MANIFEST_URL, poolOptions(workers));
    await p.getTile(0, 0, 0);
    p.destroy();
    expect(workers.length).toBe(2);
    expect(workers.every((w) => w.terminated)).toBe(true);
    await expect(p.getTile(0, 0, 0)).rejects.toThrow(/destroy/i);
  });

  it('surfaces an out-of-range tile request as a rejected promise', async () => {
    const workers: Array<ReturnType<typeof createInProcessWorker>> = [];
    const p = await TilePyramid.load(MANIFEST_URL, poolOptions(workers));
    await expect(p.getTile(0, 9, 9)).rejects.toThrow(/out of range/i);
    p.destroy();
  });

  it('tears down the pool workers when the manifest load fails, so they do not leak', async () => {
    const workers: Array<ReturnType<typeof createInProcessWorker>> = [];
    const failingManifestFetch = (async () =>
      new Response('not found', { status: 404, statusText: 'Not Found' })) as unknown as typeof fetch;
    await expect(
      TilePyramid.load(MANIFEST_URL, poolOptions(workers, { fetchImpl: failingManifestFetch })),
    ).rejects.toThrow(/manifest fetch failed|404/i);
    expect(workers.length).toBe(2);
    expect(workers.every((w) => w.terminated)).toBe(true);
  });
});

describe('TileEngine — persistent disk cache (BlobStore tier)', () => {
  function loadEngine(blobStore: BlobStore | null, rangeFetch = fixtureRangeFetcher()) {
    return {
      rangeFetch,
      engine: TileEngine.load(MANIFEST_URL, {
        fetchImpl: manifestFetch(),
        rangeFetch: rangeFetch.fetch,
        blobStore,
      }),
    };
  }

  it('writes fetched compressed bytes through to the store on a cold miss', async () => {
    const mem = createMemoryBlobStore();
    const engine = await TileEngine.load(MANIFEST_URL, {
      fetchImpl: manifestFetch(),
      rangeFetch: fixtureRangeFetcher().fetch,
      blobStore: mem.store,
    });
    await engine.getTile(1, 0, 0);
    expect(mem.puts.length).toBe(1);
    // Key is `${fingerprint}/level/x/y`.
    expect([...mem.map.keys()][0]).toMatch(/\/1\/0\/0$/);
  });

  it('a second engine sharing the store serves the tile from disk, bit-identically, with no tile fetch', async () => {
    const mem = createMemoryBlobStore();

    const fa = fixtureRangeFetcher();
    const engineA = await TileEngine.load(MANIFEST_URL, {
      fetchImpl: manifestFetch(),
      rangeFetch: fa.fetch,
      blobStore: mem.store,
    });
    const a = await engineA.getTile(1, 0, 0);

    const fb = fixtureRangeFetcher();
    const engineB = await TileEngine.load(MANIFEST_URL, {
      fetchImpl: manifestFetch(),
      rangeFetch: fb.fetch,
      blobStore: mem.store,
    });
    const b = await engineB.getTile(1, 0, 0);

    // Correct + bit-identical to a fresh decode.
    expect(firstFloatMismatch(b, readFixtureFloat32('z1_decoded.bin'), 0)).toBe(-1);
    expect(firstFloatMismatch(b, a, 0)).toBe(-1);
    // The store served the tile (a hit), and engine B issued strictly fewer range
    // requests than the cold engine A — the tile-heap fetch was avoided.
    expect(mem.hits.some((k) => k.endsWith('/1/0/0'))).toBe(true);
    expect(fb.calls.length).toBeLessThan(fa.calls.length);
    expect(fb.calls.length).toBeGreaterThan(0); // still opens the file (metadata RTT)
  });

  it('degrades to the network when the store throws on get/put', async () => {
    const throwing: BlobStore = {
      get: () => Promise.reject(new Error('boom')),
      put: () => Promise.reject(new Error('boom')),
    };
    const { engine } = loadEngine(throwing);
    const tile = await (await engine).getTile(1, 0, 0);
    expect(firstFloatMismatch(tile, readFixtureFloat32('z1_decoded.bin'), 0)).toBe(-1);
  });

  it('blobStore: null disables the tier (no get/put attempted) and still decodes', async () => {
    const tile = await (await loadEngine(null).engine).getTile(1, 0, 0);
    expect(firstFloatMismatch(tile, readFixtureFloat32('z1_decoded.bin'), 0)).toBe(-1);
  });
});

describe('TileEngine — request cancellation (AbortSignal)', () => {
  // Head/index fetches carry no signal -> serve from the fixture immediately; the
  // tile-heap fetch carries the signal -> hang until aborted, then reject like a
  // real aborted fetch does (with the signal's reason, a DOMException AbortError).
  function cancellableFetcher(): RangeFetcher {
    const base = fixtureRangeFetcher().fetch;
    return (url, start, end, signal) => {
      if (signal === undefined) return base(url, start, end);
      return new Promise<Uint8Array>((_resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener('abort', () => reject(signal.reason));
      });
    };
  }

  it('aborts an in-flight tile fetch and rejects with an AbortError', async () => {
    const engine = await TileEngine.load(MANIFEST_URL, {
      fetchImpl: manifestFetch(),
      rangeFetch: cancellableFetcher(),
      blobStore: null,
    });
    const ac = new AbortController();
    const p = engine.getTile(1, 0, 0, ac.signal);
    ac.abort();
    const err = await p.catch((e: unknown) => e);
    expect(isAbortError(err)).toBe(true);
  });

  it('skips decode when the signal is already aborted (no wasted decode-pool slot)', async () => {
    // The fixture fetcher ignores the signal, so the bytes resolve; the post-fetch
    // throwIfAborted check must reject before any decode happens.
    const engine = await TileEngine.load(MANIFEST_URL, {
      fetchImpl: manifestFetch(),
      rangeFetch: fixtureRangeFetcher().fetch,
      blobStore: null,
    });
    const ac = new AbortController();
    ac.abort();
    const err = await engine.getTile(1, 0, 0, ac.signal).catch((e: unknown) => e);
    expect(isAbortError(err)).toBe(true);
  });

  it('resolves normally when the signal is wired in but never aborted', async () => {
    const engine = await TileEngine.load(MANIFEST_URL, {
      fetchImpl: manifestFetch(),
      rangeFetch: fixtureRangeFetcher().fetch,
      blobStore: null,
    });
    const ac = new AbortController();
    const tile = await engine.getTile(1, 0, 0, ac.signal);
    expect(firstFloatMismatch(tile, readFixtureFloat32('z1_decoded.bin'), 0)).toBe(-1);
  });
});
