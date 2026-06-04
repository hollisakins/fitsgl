import { describe, it, expect } from 'vitest';
import { decodeGzip2Tile, gunzip } from '../src/fpack/decode-gzip2.js';
import {
  b64ToBytes,
  loadExpected,
  readFixtureFloat32,
  sliceTile,
  firstFloatMismatch,
} from './helpers.js';

const expected = loadExpected();
const native = readFixtureFloat32('native.bin'); // 512x512 row-major float32

describe('decodeGzip2Tile — lossless', () => {
  it('decodes the sample GZIP_2 tile bit-exactly, NaN positions included', async () => {
    const sample = expected.sampleGzip2Tile;
    const bytes = b64ToBytes(sample.compressed_b64);
    const decoded = await decodeGzip2Tile(bytes, sample.nPixels);
    expect(decoded.length).toBe(sample.nPixels);

    const expectedTile = sliceTile(native, 512, sample.tileX, sample.tileY, 256, 256);
    const mismatch = firstFloatMismatch(decoded, expectedTile, 0); // exact
    expect(mismatch).toBe(-1);

    // The tile genuinely contains NaNs (proves NaN survives the pipeline).
    const nanCount = decoded.reduce((n, v) => n + (Number.isNaN(v) ? 1 : 0), 0);
    expect(nanCount).toBeGreaterThan(0);
  });

  it('gunzip produces the expected raw shuffled byte length (nPixels*4)', async () => {
    const bytes = b64ToBytes(expected.sampleGzip2Tile.compressed_b64);
    const raw = await gunzip(bytes);
    expect(raw.byteLength).toBe(expected.sampleGzip2Tile.nPixels * 4);
  });

  it('throws if the decoded byte length does not match the expected pixel count', async () => {
    const bytes = b64ToBytes(expected.sampleGzip2Tile.compressed_b64);
    await expect(decodeGzip2Tile(bytes, 12345)).rejects.toThrow(/expected|shuffle/i);
  });
});
