import { describe, it, expect } from 'vitest';
import { TilePyramid, TileEngine } from '../src/fpack/tile-source.js';
import {
  MANIFEST_URL,
  manifestFetch,
  fixtureRangeFetcher,
  createInProcessWorker,
  readFixtureFloat32,
  sliceTile,
  firstFloatMismatch,
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
});

describe('TilePyramid (worker mode, in-process worker)', () => {
  function workerPyramid() {
    let worker: ReturnType<typeof createInProcessWorker> | null = null;
    const factory = () => {
      worker = createInProcessWorker({ rangeFetch: fixtureRangeFetcher().fetch, fetchImpl: manifestFetch() });
      return worker;
    };
    return { factory, getWorker: () => worker! };
  }

  it('loads through the worker protocol and returns correct tiles', async () => {
    const { factory } = workerPyramid();
    const p = await TilePyramid.load(MANIFEST_URL, { useWorker: true, workerFactory: factory });
    expect(p.getManifest().n_levels).toBe(1);

    const g = await p.getTile(0, 0, 0);
    expect(firstFloatMismatch(g, sliceTile(native, 512, 0, 0, 256, 256), 0)).toBe(-1);
    const r = await p.getTile(1, 0, 0);
    expect(firstFloatMismatch(r, z1Decoded, 0)).toBe(-1);
    p.destroy();
  });

  it('dedupes concurrent identical requests on the main side', async () => {
    const { factory } = workerPyramid();
    const p = await TilePyramid.load(MANIFEST_URL, { useWorker: true, workerFactory: factory });
    const results = await Promise.all(Array.from({ length: 5 }, () => p.getTile(0, 1, 0)));
    const expectedTile = sliceTile(native, 512, 1, 0, 256, 256);
    for (const r of results) expect(firstFloatMismatch(r, expectedTile, 0)).toBe(-1);
    p.destroy();
  });

  it('destroy() terminates the worker and rejects later getTile calls', async () => {
    const wp = workerPyramid();
    const p = await TilePyramid.load(MANIFEST_URL, { useWorker: true, workerFactory: wp.factory });
    await p.getTile(0, 0, 0);
    p.destroy();
    expect(wp.getWorker().terminated).toBe(true);
    await expect(p.getTile(0, 0, 0)).rejects.toThrow(/destroy/i);
  });

  it('surfaces worker-side errors (out-of-range tile) as a rejected promise', async () => {
    const { factory } = workerPyramid();
    const p = await TilePyramid.load(MANIFEST_URL, { useWorker: true, workerFactory: factory });
    await expect(p.getTile(0, 9, 9)).rejects.toThrow(/out of range/i);
    p.destroy();
  });

  it('terminates the worker when init fails, so a failed load does not leak it', async () => {
    let worker: ReturnType<typeof createInProcessWorker> | null = null;
    const failingManifestFetch = (async () =>
      new Response('not found', { status: 404, statusText: 'Not Found' })) as unknown as typeof fetch;
    const factory = () => {
      worker = createInProcessWorker({
        rangeFetch: fixtureRangeFetcher().fetch,
        fetchImpl: failingManifestFetch,
      });
      return worker;
    };
    await expect(
      TilePyramid.load(MANIFEST_URL, { useWorker: true, workerFactory: factory }),
    ).rejects.toThrow(/manifest fetch failed|404/i);
    expect(worker).not.toBeNull();
    expect(worker!.terminated).toBe(true);
  });
});
