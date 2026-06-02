import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { decodeRiceTile } from '../src/fpack/decode-rice.js';
import { SUBTRACTIVE_DITHER_2 } from '../src/fpack/dither.js';
import { FpackFile, type RangeFetcher } from '../src/fpack/fpack-file.js';
import { b64ToBytes, firstUlpMismatch, sliceTile } from './helpers.js';

interface DitherTile {
  name: string;
  method: string;
  zdither0: number;
  tile_index: number;
  n_pixels: number;
  block_size: number;
  zscale: number;
  zzero: number;
  zblank: number | null;
  n_nan: number;
  n_exact_zero: number;
  max_ulp_plain_vs_astropy: number;
  compressed_b64: string;
  decoded_b64: string;
}
interface DitherFixtures {
  max_ulp_plain_vs_astropy: number;
  count: number;
  tiles: DitherTile[];
}

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'dither_fixtures.json');
const data = JSON.parse(readFileSync(FIX, 'utf8')) as DitherFixtures;

/** astropy's decoded float32 pixels for a tile (little-endian on disk). */
function refFloats(b64: string): Float32Array {
  const u = b64ToBytes(b64);
  return new Float32Array(u.buffer, u.byteOffset, u.byteLength / 4);
}

function decode(t: DitherTile): Float32Array {
  return decodeRiceTile(
    b64ToBytes(t.compressed_b64),
    t.zscale,
    t.zzero,
    t.zblank ?? NaN, // a missing ZBLANK means "no blanks": NaN never matches a decoded int
    t.n_pixels,
    t.block_size,
    { method: SUBTRACTIVE_DITHER_2, seed: t.zdither0, tileIndex: t.tile_index },
  );
}

describe('decodeRiceTile — SUBTRACTIVE_DITHER_2 matches astropy', () => {
  it('has fixtures whose worst case is the documented <=1 ULP FMA gap', () => {
    expect(data.tiles.length).toBeGreaterThan(0);
    expect(data.max_ulp_plain_vs_astropy).toBeLessThanOrEqual(1);
  });

  for (const t of data.tiles) {
    it(`${t.name}: within 1 ULP of astropy, NaN mask + exact zeros bit-exact`, () => {
      const decoded = decode(t);
      const ref = refFloats(t.decoded_b64);
      expect(decoded.length).toBe(t.n_pixels);
      expect(ref.length).toBe(t.n_pixels);

      // Finite pixels match astropy to <=1 float32 ULP; NaN positions must align
      // exactly (firstUlpMismatch treats NaN!==finite as a mismatch).
      expect(firstUlpMismatch(decoded, ref, 1)).toBe(-1);

      // The NaN mask is reproduced exactly (the ZBLANK sentinel -> NaN path).
      const nanCount = decoded.reduce((n, v) => n + (Number.isNaN(v) ? 1 : 0), 0);
      expect(nanCount).toBe(t.n_nan);

      // SUBTRACTIVE_DITHER_2 exact-zero pixels decode to *exactly* 0.0 (the
      // ZERO_VALUE sentinel path bypasses the dither/FMA arithmetic).
      let zeroCount = 0;
      for (let i = 0; i < ref.length; i++) {
        if (ref[i] === 0) {
          zeroCount++;
          expect(decoded[i]).toBe(0);
        }
      }
      expect(zeroCount).toBe(t.n_exact_zero);
    });
  }

  it('the dither reversal is load-bearing (omitting it diverges by >>1 ULP)', () => {
    // The tile with NaNs + exact zeros is the most discriminating.
    const t = data.tiles.find((x) => x.n_nan > 0 && x.n_exact_zero > 0) ?? data.tiles[0]!;
    const ref = refFloats(t.decoded_b64);
    const noDither = decodeRiceTile(
      b64ToBytes(t.compressed_b64),
      t.zscale,
      t.zzero,
      t.zblank ?? NaN,
      t.n_pixels,
      t.block_size,
      // no dither context -> plain int*scale+zero, which is wrong for a dithered tile
    );
    expect(firstUlpMismatch(noDither, ref, 1)).not.toBe(-1);
  });
});

interface PyramidMeta {
  znaxis1: number;
  znaxis2: number;
  ztile1: number;
  ztile2: number;
  zdither0: number;
  zquantiz: string;
  n_tiles_x: number;
  n_tiles_y: number;
  decoded_b64: string;
}

describe('FpackFile — dithered file decodes end-to-end through getTile', () => {
  const fixDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
  const fileBytes = readFileSync(join(fixDir, 'dither_pyramid.fits.fz'));
  const buf = new Uint8Array(fileBytes.buffer, fileBytes.byteOffset, fileBytes.byteLength);
  const meta = JSON.parse(
    readFileSync(join(fixDir, 'dither_pyramid_expected.json'), 'utf8'),
  ) as PyramidMeta;
  const refImg = (() => {
    const u = b64ToBytes(meta.decoded_b64);
    return new Float32Array(u.buffer, u.byteOffset, u.byteLength / 4);
  })();

  const fetcher: RangeFetcher = async (_url, start, end) =>
    buf.subarray(start, Math.min(end + 1, buf.length));

  it('reads ZQUANTIZ/ZDITHER0 and decodes every tile to <=1 ULP of astropy', async () => {
    const file = await FpackFile.open('dither_pyramid.fits.fz', fetcher);
    // The wiring under test: open() pulled the dither method + seed from the header.
    expect(file.ditherMethod).toBe(SUBTRACTIVE_DITHER_2);
    expect(file.zdither0).toBe(meta.zdither0);
    expect(file.nTilesX).toBe(meta.n_tiles_x);
    expect(file.nTilesY).toBe(meta.n_tiles_y);

    let totalNaN = 0;
    for (let ty = 0; ty < file.nTilesY; ty++) {
      for (let tx = 0; tx < file.nTilesX; tx++) {
        const decoded = await file.getTile(tx, ty);
        // All tiles here are full ztile1 x ztile2 (no edge tiles in this fixture).
        const ref = sliceTile(refImg, meta.znaxis1, tx, ty, meta.ztile1, meta.ztile2);
        expect(firstUlpMismatch(decoded, ref, 1)).toBe(-1);
        totalNaN += decoded.reduce((n, v) => n + (Number.isNaN(v) ? 1 : 0), 0);
      }
    }
    // Tile (0,0) carried a NaN patch — confirm blanks survived the full path.
    expect(totalNaN).toBeGreaterThan(0);
  });
});
