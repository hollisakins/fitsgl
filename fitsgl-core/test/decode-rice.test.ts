import { describe, it, expect } from 'vitest';
import { decodeRiceTile } from '../src/fpack/decode-rice.js';
import { b64ToBytes, loadExpected, readFixtureFloat32, firstFloatMismatch } from './helpers.js';

const expected = loadExpected();
const z1Decoded = readFixtureFloat32('z1_decoded.bin'); // astropy's RICE decode, 256x256

describe('decodeRiceTile — matches astropy decode', () => {
  it('reproduces astropy RICE decode exactly (same quantization math), NaNs included', () => {
    const s = expected.sampleRiceTile;
    const bytes = b64ToBytes(s.compressed_b64);
    const decoded = decodeRiceTile(bytes, s.zscale, s.zzero, s.zblank, s.nPixels, s.blockSize);
    expect(decoded.length).toBe(s.nPixels);

    // The dequantization int*ZSCALE+ZZERO (float64 → float32) is deterministic,
    // so the TS decode must equal astropy's stored float32 exactly. This is a
    // much tighter check than the q=16 tolerance against the original floats.
    const mismatch = firstFloatMismatch(decoded, z1Decoded, 0);
    expect(mismatch).toBe(-1);
  });

  it('maps the ZBLANK sentinel to NaN (and the tile actually has blanks)', () => {
    const s = expected.sampleRiceTile;
    const decoded = decodeRiceTile(
      b64ToBytes(s.compressed_b64),
      s.zscale,
      s.zzero,
      s.zblank,
      s.nPixels,
      s.blockSize,
    );
    const nanCount = decoded.reduce((n, v) => n + (Number.isNaN(v) ? 1 : 0), 0);
    const refNaN = z1Decoded.reduce((n, v) => n + (Number.isNaN(v) ? 1 : 0), 0);
    expect(nanCount).toBe(refNaN);
    expect(nanCount).toBeGreaterThan(0);
  });

  it('is within q=16 quantization tolerance of being a smooth image (sanity)', () => {
    // A weak structural check: finite values are finite and bounded (not NaN/Inf
    // garbage), confirming the dequantization produced real numbers.
    const s = expected.sampleRiceTile;
    const decoded = decodeRiceTile(
      b64ToBytes(s.compressed_b64),
      s.zscale,
      s.zzero,
      s.zblank,
      s.nPixels,
      s.blockSize,
    );
    const finite = [...decoded].filter((v) => Number.isFinite(v));
    expect(finite.length).toBeGreaterThan(0);
    expect(finite.every((v) => Math.abs(v) < 1e6)).toBe(true);
  });
});
