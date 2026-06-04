import { describe, it, expect } from 'vitest';
import { FpackFile, type RangeFetcher } from '../src/fpack/fpack-file.js';
import {
  readFixtureBytes,
  readFixtureFloat32,
  loadExpected,
  sliceTile,
  firstFloatMismatch,
} from './helpers.js';

const expected = loadExpected();
const native = readFixtureFloat32('native.bin');
const z1Decoded = readFixtureFloat32('z1_decoded.bin');

const Z0_URL = 'https://fixtures.test/p/synthetic_z0.fits.fz';
const Z1_URL = 'https://fixtures.test/p/synthetic_z1.fits.fz';

/** A RangeFetcher serving one in-memory buffer (ignores the URL). */
function bufferFetcher(buf: Uint8Array): { fetch: RangeFetcher; count: number } {
  const state = { count: 0 } as { count: number };
  const fetch: RangeFetcher = async (_url, start, end) => {
    state.count++;
    if (start >= buf.length) return new Uint8Array(0);
    return buf.subarray(start, Math.min(end + 1, buf.length));
  };
  return Object.assign(state, { fetch });
}

function findAscii(buf: Uint8Array, needle: string): number {
  const bytes = [...needle].map((c) => c.charCodeAt(0));
  outer: for (let i = 0; i <= buf.length - bytes.length; i++) {
    for (let j = 0; j < bytes.length; j++) if (buf[i + j] !== bytes[j]) continue outer;
    return i;
  }
  return -1;
}

describe('FpackFile.open — metadata', () => {
  it('reads GZIP_2 metadata', async () => {
    const f = await FpackFile.open(Z0_URL, bufferFetcher(readFixtureBytes('synthetic_z0.fits.fz')).fetch);
    expect(f.compressionType).toBe('GZIP_2');
    expect(f.znaxis1).toBe(512);
    expect(f.znaxis2).toBe(512);
    expect(f.ztile1).toBe(256);
    expect(f.ztile2).toBe(256);
    expect(f.nTilesX).toBe(2);
    expect(f.nTilesY).toBe(2);
  });

  it('reads RICE_1 metadata including block size', async () => {
    const f = await FpackFile.open(Z1_URL, bufferFetcher(readFixtureBytes('synthetic_z1.fits.fz')).fetch);
    expect(f.compressionType).toBe('RICE_1');
    expect(f.znaxis1).toBe(256);
    expect(f.nTilesX).toBe(1);
    expect(f.nTilesY).toBe(1);
    expect(f.blockSize).toBe(32);
  });

  it('grows the metadata fetch when the headers do not fit the initial chunk', async () => {
    // Headers occupy 8640 bytes; start with a deliberately tiny initial window.
    const f = await FpackFile.open(
      Z0_URL,
      bufferFetcher(readFixtureBytes('synthetic_z0.fits.fz')).fetch,
      { initialBytes: 4096 },
    );
    expect(f.compressionType).toBe('GZIP_2');
  });

  it('rejects an unsupported ZCMPTYPE with a descriptive error', async () => {
    const patched = readFixtureBytes('synthetic_z1.fits.fz').slice();
    const at = findAscii(patched, 'RICE_1');
    expect(at).toBeGreaterThan(0);
    for (let i = 0; i < 6; i++) patched[at + i] = 'PLIO_1'.charCodeAt(i);
    await expect(FpackFile.open(Z1_URL, bufferFetcher(patched).fetch)).rejects.toThrow(
      /unsupported ZCMPTYPE|PLIO_1/i,
    );
  });

  it('rejects a lossless/integer RICE file (no ZSCALE/ZZERO) instead of decoding to NaN', async () => {
    const lossless = readFixtureBytes('lossless_rice.fits.fz'); // RICE_1, int32, no ZSCALE
    await expect(
      FpackFile.open('https://fixtures.test/p/lossless_rice.fits.fz', bufferFetcher(lossless).fetch),
    ).rejects.toThrow(/ZSCALE|lossless|integer/i);
  });
});

describe('FpackFile.loadTileIndex', () => {
  it('returns one entry per tile with sequential, in-bounds descriptors', async () => {
    const f = await FpackFile.open(Z0_URL, bufferFetcher(readFixtureBytes('synthetic_z0.fits.fz')).fetch);
    const index = await f.loadTileIndex();
    expect(index.length).toBe(4);
    let off = 0;
    for (const e of index) {
      expect(e.heapOffset).toBe(off);
      expect(e.nBytes).toBeGreaterThan(0);
      off += e.nBytes;
    }
  });

  it('captures ZSCALE/ZZERO/ZBLANK for RICE tiles', async () => {
    const f = await FpackFile.open(Z1_URL, bufferFetcher(readFixtureBytes('synthetic_z1.fits.fz')).fetch);
    const index = await f.loadTileIndex();
    expect(index.length).toBe(1);
    expect(index[0]!.zscale).toBeCloseTo(expected.sampleRiceTile.zscale, 12);
    expect(index[0]!.zzero).toBeCloseTo(expected.sampleRiceTile.zzero, 12);
    expect(index[0]!.zblank).toBe(-2147483648);
  });
});

describe('FpackFile.getTile', () => {
  it('GZIP_2 tiles decode losslessly against the native image (all 4 tiles)', async () => {
    const f = await FpackFile.open(Z0_URL, bufferFetcher(readFixtureBytes('synthetic_z0.fits.fz')).fetch);
    for (let ty = 0; ty < f.nTilesY; ty++) {
      for (let tx = 0; tx < f.nTilesX; tx++) {
        const tile = await f.getTile(tx, ty);
        const expectedTile = sliceTile(native, 512, tx, ty, 256, 256);
        expect(firstFloatMismatch(tile, expectedTile, 0)).toBe(-1);
      }
    }
  });

  it('RICE_1 tile matches astropy decode', async () => {
    const f = await FpackFile.open(Z1_URL, bufferFetcher(readFixtureBytes('synthetic_z1.fits.fz')).fetch);
    const tile = await f.getTile(0, 0);
    expect(firstFloatMismatch(tile, z1Decoded, 0)).toBe(-1);
  });

  it('reports correct (full) tile dimensions and rejects out-of-range coordinates', async () => {
    const f = await FpackFile.open(Z0_URL, bufferFetcher(readFixtureBytes('synthetic_z0.fits.fz')).fetch);
    expect(f.tileDims(0, 0)).toEqual({ width: 256, height: 256 });
    await expect(f.getTile(2, 0)).rejects.toThrow(/out of range/i);
    await expect(f.getTile(0, -1)).rejects.toThrow(/out of range/i);
  });
});

describe('FpackFile split fetch/decode (cache seam)', () => {
  // The persistent tile cache (multi-tier-cache plan, P2) caches the COMPRESSED
  // bytes and decodes them later via the static decodeTile. The split path must be
  // bit-identical to getTile — the decode is a pure function of (bytes, params),
  // so cached bytes must decode the same as freshly-fetched ones.
  it('decodeTile(fetchCompressedTile, tileDecodeParams) == getTile, bit-exact (GZIP_2, all tiles)', async () => {
    const f = await FpackFile.open(Z0_URL, bufferFetcher(readFixtureBytes('synthetic_z0.fits.fz')).fetch);
    for (let ty = 0; ty < f.nTilesY; ty++) {
      for (let tx = 0; tx < f.nTilesX; tx++) {
        const direct = await f.getTile(tx, ty);
        const bytes = await f.fetchCompressedTile(tx, ty);
        const params = await f.tileDecodeParams(tx, ty);
        const split = await FpackFile.decodeTile(bytes, params);
        expect(firstFloatMismatch(split, direct, 0)).toBe(-1);
      }
    }
  });

  it('decodeTile(fetchCompressedTile, tileDecodeParams) == getTile, bit-exact (RICE_1)', async () => {
    const f = await FpackFile.open(Z1_URL, bufferFetcher(readFixtureBytes('synthetic_z1.fits.fz')).fetch);
    const direct = await f.getTile(0, 0);
    const bytes = await f.fetchCompressedTile(0, 0);
    const params = await f.tileDecodeParams(0, 0);
    const split = await FpackFile.decodeTile(bytes, params);
    expect(firstFloatMismatch(split, direct, 0)).toBe(-1);
    expect(firstFloatMismatch(split, z1Decoded, 0)).toBe(-1);
  });

  it('fetchCompressedTile returns the raw compressed heap bytes (non-empty)', async () => {
    const f = await FpackFile.open(Z1_URL, bufferFetcher(readFixtureBytes('synthetic_z1.fits.fz')).fetch);
    const bytes = await f.fetchCompressedTile(0, 0);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
    // Decoding the returned bytes round-trips to the expected pixels.
    const params = await f.tileDecodeParams(0, 0);
    expect(params.compressionType).toBe('RICE_1');
    expect(params.nPixels).toBe(256 * 256);
  });

  it('the split methods reject out-of-range coordinates like getTile', async () => {
    const f = await FpackFile.open(Z0_URL, bufferFetcher(readFixtureBytes('synthetic_z0.fits.fz')).fetch);
    await expect(f.tileDecodeParams(2, 0)).rejects.toThrow(/out of range/i);
    await expect(f.fetchCompressedTile(0, -1)).rejects.toThrow(/out of range/i);
  });
});

describe('httpRangeFetch — Range semantics', () => {
  it('accepts 206, rejects 200, and surfaces network errors', async () => {
    const { httpRangeFetch } = await import('../src/fpack/fpack-file.js');
    const data = new Uint8Array([1, 2, 3, 4]);
    const originalFetch = globalThis.fetch;
    try {
      const ok = ((async () =>
        new Response(data as unknown as BodyInit, { status: 206 })) as unknown) as typeof fetch;
      globalThis.fetch = ok;
      expect((await httpRangeFetch('u', 0, 3)).length).toBe(4);

      const ignored = ((async () =>
        new Response(data as unknown as BodyInit, { status: 200 })) as unknown) as typeof fetch;
      globalThis.fetch = ignored;
      await expect(httpRangeFetch('u', 0, 3)).rejects.toThrow(/200|ignored the Range/i);

      const boom = ((async () => {
        throw new Error('network down');
      }) as unknown) as typeof fetch;
      globalThis.fetch = boom;
      await expect(httpRangeFetch('u', 0, 3)).rejects.toThrow(/network down/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
