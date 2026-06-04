/**
 * Test helpers for Phase 2b: load committed fixtures, serve them through a
 * RangeFetcher / manifest fetch, and run the tile worker in-process.
 *
 * These use `node:fs` (tests run under Node); the library `src/` never does.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { attachDecodeWorker } from '../src/worker.js';
import type { RangeFetcher } from '../src/index.js';
import type { WorkerLike, WorkerScopeLike } from '../src/fpack/worker-protocol.js';
import type { BlobStore } from '../src/fpack/blob-store.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FIX_DIR = join(FIXTURES, 'pyramid2b');
const CHUNKED_FIX_DIR = join(FIXTURES, 'chunked');

export const MANIFEST_URL = 'https://fixtures.test/pyramid2b/manifest.json';
/** A real v2 (supertiles) pyramid whose z=0 level is split across four files. */
export const CHUNKED_MANIFEST_URL = 'https://fixtures.test/chunked/manifest.json';

function readBytesFrom(dir: string, name: string): Uint8Array {
  const buf = readFileSync(join(dir, name));
  return new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

export function readFixtureBytes(name: string): Uint8Array {
  return readBytesFrom(FIX_DIR, name);
}

export function readChunkedBytes(name: string): Uint8Array {
  return readBytesFrom(CHUNKED_FIX_DIR, name);
}

export function readChunkedFloat32(name: string): Float32Array {
  const bytes = readChunkedBytes(name);
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
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

// float32 ULP comparison (used for the dithered RICE decode, which matches
// astropy only to within ≤1 ULP because astropy's C unquantizer uses an FMA the
// JS path cannot reproduce; the FITS standard does not mandate FMA).
const _f32buf = new ArrayBuffer(4);
const _f32view = new Float32Array(_f32buf);
const _u32view = new Uint32Array(_f32buf);

/** Monotonic ordering key for a float32 value, so ULP distance = |keyA - keyB|. */
function f32OrderedKey(x: number): number {
  _f32view[0] = x;
  const u = _u32view[0]!;
  // Positives: shift above the midpoint; negatives: reflect below it.
  return u < 0x80000000 ? u + 0x80000000 : 0xffffffff - u;
}

/**
 * First index where two float32 arrays differ by more than `maxUlps` ULPs
 * (NaN===NaN; NaN vs finite is always a mismatch). Returns -1 if all within
 * tolerance, -2 on length mismatch.
 */
export function firstUlpMismatch(a: Float32Array, b: Float32Array, maxUlps: number): number {
  if (a.length !== b.length) return -2;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    const xn = Number.isNaN(x);
    const yn = Number.isNaN(y);
    if (xn && yn) continue;
    if (xn !== yn) return i;
    if (Math.abs(f32OrderedKey(x) - f32OrderedKey(y)) > maxUlps) return i;
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

/** A RangeFetcher served from the committed CHUNKED fixture, keyed by filename. */
export function chunkedRangeFetcher(): {
  fetch: RangeFetcher;
  calls: Array<{ name: string; start: number; end: number }>;
} {
  const cache = new Map<string, Uint8Array>();
  const calls: Array<{ name: string; start: number; end: number }> = [];
  const fetch: RangeFetcher = async (url, start, end) => {
    const name = url.split('/').pop()!;
    calls.push({ name, start, end });
    let buf = cache.get(name);
    if (buf === undefined) {
      buf = readChunkedBytes(name);
      cache.set(name, buf);
    }
    if (start >= buf.length) return new Uint8Array(0);
    return buf.subarray(start, Math.min(end + 1, buf.length));
  };
  return { fetch, calls };
}

/** A fetch impl returning the chunked fixture's v2 manifest.json for any URL. */
export function chunkedManifestFetch(): typeof fetch {
  const bytes = readChunkedBytes('manifest.json');
  return (async () =>
    new Response(bytes as unknown as BodyInit, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

/**
 * An in-process stateless decode worker: routes messages between a real
 * `attachDecodeWorker` scope and a main-side `WorkerLike` via microtasks. Lets the
 * decode worker protocol be tested end-to-end in Node (the worker only decodes;
 * fetch + caches live on the main-thread `TileEngine`).
 */
export function createInProcessWorker(): WorkerLike & { terminated: boolean } {
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

  attachDecodeWorker(scope);

  main.postMessage = (msg: unknown) => {
    queueMicrotask(() => {
      if (!terminated) scope.onmessage?.({ data: msg });
    });
  };

  return main;
}

/**
 * In-memory {@link BlobStore} for testing the disk tier without IndexedDB. Records
 * gets/hits/puts (and stores compact copies) so a test can assert write-through,
 * cross-engine hits, and that a tile fetch was avoided.
 */
export function createMemoryBlobStore(): {
  store: BlobStore;
  map: Map<string, Uint8Array>;
  gets: string[];
  hits: string[];
  puts: string[];
} {
  const map = new Map<string, Uint8Array>();
  const gets: string[] = [];
  const hits: string[] = [];
  const puts: string[] = [];
  const store: BlobStore = {
    get(key) {
      gets.push(key);
      const v = map.get(key);
      if (v !== undefined) hits.push(key);
      return Promise.resolve(v ? v.slice() : undefined);
    },
    put(key, bytes) {
      puts.push(key);
      map.set(key, bytes.slice());
      return Promise.resolve();
    },
  };
  return { store, map, gets, hits, puts };
}
