/**
 * Test helpers for Phase 2b: load committed fixtures, serve them through a
 * RangeFetcher / manifest fetch, and run the tile worker in-process.
 *
 * These use `node:fs` (tests run under Node); the library `src/` never does.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { attachTileWorker } from '../src/worker.js';
import type { RangeFetcher } from '../src/index.js';
import type { WorkerLike, WorkerScopeLike } from '../src/fpack/worker-protocol.js';

const FIX_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pyramid2b');

export const MANIFEST_URL = 'https://fixtures.test/pyramid2b/manifest.json';

export function readFixtureBytes(name: string): Uint8Array {
  const buf = readFileSync(join(FIX_DIR, name));
  return new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

export function readFixtureFloat32(name: string): Float32Array {
  const bytes = readFixtureBytes(name);
  // Little-endian on disk; platform is little-endian, so a direct view is correct.
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

export function readFixtureJson<T>(name: string): T {
  return JSON.parse(new TextDecoder().decode(readFixtureBytes(name))) as T;
}

export interface SampleTile {
  level: number;
  tileX: number;
  tileY: number;
  nPixels: number;
  blockSize?: number;
  zscale?: number;
  zzero?: number;
  zblank?: number;
  compressed_b64: string;
}

export interface ExpectedFixtures {
  tileSize: number;
  nativeShape: [number, number];
  levels: Array<{
    z: number;
    filename: string;
    compression: string;
    shape: [number, number];
    nTilesX: number;
    nTilesY: number;
    zblank?: number;
  }>;
  native: { file: string; shape: [number, number] };
  z1Decoded: { file: string; shape: [number, number] };
  sampleGzip2Tile: SampleTile;
  sampleRiceTile: Required<Omit<SampleTile, never>>;
}

export function loadExpected(): ExpectedFixtures {
  return readFixtureJson<ExpectedFixtures>('expected.json');
}

/** Extract a row-major tile [ty*size : +h, tx*size : +w] from a flat row-major image. */
export function sliceTile(
  image: Float32Array,
  imageWidth: number,
  tileX: number,
  tileY: number,
  tileW: number,
  tileH: number,
): Float32Array {
  const out = new Float32Array(tileW * tileH);
  for (let r = 0; r < tileH; r++) {
    const srcRow = (tileY * tileH + r) * imageWidth + tileX * tileW;
    for (let c = 0; c < tileW; c++) out[r * tileW + c] = image[srcRow + c]!;
  }
  return out;
}

/** Compare two float arrays exactly, treating NaN===NaN, returning the first mismatch index or -1. */
export function firstFloatMismatch(a: Float32Array, b: Float32Array, atol = 0): number {
  if (a.length !== b.length) return -2;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    const bothNaN = Number.isNaN(x) && Number.isNaN(y);
    if (bothNaN) continue;
    if (Number.isNaN(x) !== Number.isNaN(y)) return i;
    if (atol === 0 ? x !== y : Math.abs(x - y) > atol) return i;
  }
  return -1;
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** A RangeFetcher served from in-memory fixture buffers, keyed by trailing filename. */
export function fixtureRangeFetcher(): { fetch: RangeFetcher; calls: Array<{ name: string; start: number; end: number }> } {
  const cache = new Map<string, Uint8Array>();
  const calls: Array<{ name: string; start: number; end: number }> = [];
  const fetch: RangeFetcher = async (url, start, end) => {
    const name = url.split('/').pop()!;
    calls.push({ name, start, end });
    let buf = cache.get(name);
    if (buf === undefined) {
      buf = readFixtureBytes(name);
      cache.set(name, buf);
    }
    if (start >= buf.length) return new Uint8Array(0);
    return buf.subarray(start, Math.min(end + 1, buf.length));
  };
  return { fetch, calls };
}

/** A fetch impl that returns the committed manifest.json for any URL. */
export function manifestFetch(): typeof fetch {
  const bytes = readFixtureBytes('manifest.json');
  return (async () =>
    new Response(bytes as unknown as BodyInit, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

/**
 * An in-process Web Worker: routes messages between a real `attachTileWorker`
 * scope and a main-side `WorkerLike` via microtasks. Lets the worker protocol be
 * tested end-to-end in Node with injected (closure) fetchers.
 */
export function createInProcessWorker(injected: {
  rangeFetch: RangeFetcher;
  fetchImpl: typeof fetch;
}): WorkerLike & { terminated: boolean } {
  let terminated = false;

  const main: WorkerLike & { terminated: boolean } = {
    postMessage: () => {},
    terminate: () => {
      terminated = true;
      main.terminated = true;
    },
    onmessage: null,
    terminated: false,
  };

  const scope: WorkerScopeLike = {
    postMessage: (msg: unknown) => {
      queueMicrotask(() => {
        if (!terminated) main.onmessage?.({ data: msg });
      });
    },
    onmessage: null,
  };

  attachTileWorker(scope, { rangeFetch: injected.rangeFetch, fetchImpl: injected.fetchImpl });

  main.postMessage = (msg: unknown) => {
    queueMicrotask(() => {
      if (!terminated) scope.onmessage?.({ data: msg });
    });
  };

  return main;
}
