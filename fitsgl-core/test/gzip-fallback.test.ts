/**
 * Per-tile GZIP fallback decode (the CAMPFIRE partial-filter-coverage fix).
 *
 * A tile with no quantizable signal — all-NaN (a shared-grid band's empty
 * region) or constant — is written by cfitsio/astropy with an EMPTY
 * `COMPRESSED_DATA` cell and the raw big-endian float32 pixels gzipped into
 * `GZIP_COMPRESSED_DATA`. The client used to reject these tiles outright,
 * which left the tile permanently un-decodable and pinned RGB/trilogy
 * composites at a coarse level over any region a band doesn't cover. The
 * fixture is astropy-generated (generate_fallback_fixtures.py): fallback tiles
 * must decode BIT-EXACTLY (the fallback is lossless); the quantized tiles in
 * the same file must keep matching astropy to <=1 float32 ULP.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { FpackFile, type RangeFetcher } from '../src/fpack/fpack-file.js';
import { decodeGzipFallbackTile } from '../src/fpack/decode-gzip2.js';
import { b64ToBytes, firstFloatMismatch, firstUlpMismatch, sliceTile } from './helpers.js';

interface FallbackMeta {
  znaxis1: number;
  znaxis2: number;
  ztile1: number;
  ztile2: number;
  zdither0: number;
  zquantiz: string;
  n_tiles_x: number;
  n_tiles_y: number;
  fallback_tiles: Array<[number, number]>;
  decoded_b64: string;
}

const fixDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fileBytes = readFileSync(join(fixDir, 'fallback_pyramid.fits.fz'));
const buf = new Uint8Array(fileBytes.buffer, fileBytes.byteOffset, fileBytes.byteLength);
const meta = JSON.parse(
  readFileSync(join(fixDir, 'fallback_pyramid_expected.json'), 'utf8'),
) as FallbackMeta;
const refImg = (() => {
  const u = b64ToBytes(meta.decoded_b64);
  return new Float32Array(u.buffer, u.byteOffset, u.byteLength / 4);
})();

const fetcher: RangeFetcher = async (_url, start, end) =>
  buf.subarray(start, Math.min(end + 1, buf.length));

const isFallback = (tx: number, ty: number): boolean =>
  meta.fallback_tiles.some(([fx, fy]) => fx === tx && fy === ty);

describe('FpackFile — per-tile GZIP fallback tiles decode', () => {
  it('flags fallback tiles in tileDecodeParams and decodes every tile', async () => {
    const file = await FpackFile.open('fallback_pyramid.fits.fz', fetcher);
    expect(file.nTilesX).toBe(meta.n_tiles_x);
    expect(file.nTilesY).toBe(meta.n_tiles_y);

    for (let ty = 0; ty < file.nTilesY; ty++) {
      for (let tx = 0; tx < file.nTilesX; tx++) {
        const params = await file.tileDecodeParams(tx, ty);
        expect(params.gzipFallback).toBe(isFallback(tx, ty));

        const decoded = await file.getTile(tx, ty);
        const ref = sliceTile(refImg, meta.znaxis1, tx, ty, meta.ztile1, meta.ztile2);
        if (isFallback(tx, ty)) {
          // Lossless: bit-exact, NaN positions included.
          expect(firstFloatMismatch(decoded, ref)).toBe(-1);
        } else {
          // Quantized: the usual <=1 ULP dither spec still holds in this file.
          expect(firstUlpMismatch(decoded, ref, 1)).toBe(-1);
        }
      }
    }
  });

  it('decodes the all-NaN and constant fallback tiles to their exact contents', async () => {
    const file = await FpackFile.open('fallback_pyramid.fits.fz', fetcher);
    const allNaN = await file.getTile(1, 0);
    expect(allNaN.every((v) => Number.isNaN(v))).toBe(true);
    const constant = await file.getTile(0, 1);
    expect(constant.every((v) => v === 3.25)).toBe(true);
  });

  it('rejects a fallback payload whose length does not match the tile', async () => {
    const file = await FpackFile.open('fallback_pyramid.fits.fz', fetcher);
    const bytes = await file.fetchCompressedTile(1, 0);
    await expect(decodeGzipFallbackTile(bytes, 17)).rejects.toThrow(/expected 68/);
  });
});
