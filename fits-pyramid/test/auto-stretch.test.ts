import { describe, it, expect } from 'vitest';
import { percentileRange, PERCENTILE_SAMPLE_CAP } from '../src/renderer/auto-stretch.js';

const CAP = PERCENTILE_SAMPLE_CAP;

describe('percentileRange', () => {
  it('returns the [pLo,pHi] percentiles of a 0..100 ramp', () => {
    const arr = Float32Array.from({ length: 101 }, (_, i) => i);
    // round(0.01*100)=1 ; round(0.99*100)=99
    expect(percentileRange([arr], 0.01, 0.99, CAP)).toEqual([1, 99]);
  });

  it('ignores non-finite values', () => {
    const arr = new Float32Array([0, NaN, Infinity, -Infinity, 10]);
    expect(percentileRange([arr], 0, 1, CAP)).toEqual([0, 10]);
  });

  it('combines values across multiple arrays', () => {
    const a = new Float32Array([0, 1, 2]);
    const b = new Float32Array([3, 4, 5]);
    expect(percentileRange([a, b], 0, 1, CAP)).toEqual([0, 5]);
  });

  it('returns null when all values are non-finite', () => {
    expect(percentileRange([new Float32Array([NaN, Infinity])], 0.01, 0.99, CAP)).toBeNull();
  });

  it('returns null on empty input', () => {
    expect(percentileRange([], 0.01, 0.99, CAP)).toBeNull();
    expect(percentileRange([new Float32Array(0)], 0.01, 0.99, CAP)).toBeNull();
  });

  it('returns null when the range collapses (constant data)', () => {
    expect(percentileRange([new Float32Array([5, 5, 5, 5])], 0.01, 0.99, CAP)).toBeNull();
  });

  it('subsamples with a stride when over the cap but still spans the data', () => {
    const arr = Float32Array.from({ length: 1000 }, (_, i) => i);
    const r = percentileRange([arr], 0, 1, 100); // cap forces stride=10
    expect(r).not.toBeNull();
    if (r !== null) {
      expect(r[0]).toBe(0); // idx 0 is always sampled (idx % stride === 0)
      expect(r[1]).toBeGreaterThan(900);
    }
  });
});
