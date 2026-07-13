import { describe, it, expect } from 'vitest';
import { histogram, percentileRange, PERCENTILE_SAMPLE_CAP } from '../src/renderer/auto-stretch.js';

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

  it('estimates percentiles accurately on input far larger than the default cap', () => {
    // A 1M ramp (≈16 tiles' worth of pixels): stride sampling of a ramp is
    // uniform, so the estimate should land within one stride of the true value.
    const arr = Float32Array.from({ length: 1_000_000 }, (_, i) => i);
    const r = percentileRange([arr], 0.01, 0.99);
    expect(r).not.toBeNull();
    if (r !== null) {
      expect(Math.abs(r[0] - 10_000)).toBeLessThan(20);
      expect(Math.abs(r[1] - 990_000)).toBeLessThan(20);
    }
  });

  it('preserves exact float32 values (no precision loss in the sample buffer)', () => {
    // 0.1 is inexact in binary; the sampled copy must return the float32-rounded
    // value bit-exactly, not a re-rounded approximation.
    const v = Math.fround(0.1);
    const arr = new Float32Array([v, v, v, v]);
    expect(percentileRange([arr], 0, 1, CAP)).toBeNull(); // constant -> collapsed
    const arr2 = new Float32Array([v, 2 * v]);
    const r = percentileRange([arr2], 0, 1, CAP);
    expect(r).toEqual([v, 2 * v]);
  });
});

describe('histogram', () => {
  it('bins a uniform ramp into equal counts', () => {
    const arr = Float32Array.from({ length: 100 }, (_, i) => i); // 0..99
    const counts = histogram([arr], 10, 0, 100, CAP);
    expect(counts.length).toBe(10);
    expect(Array.from(counts)).toEqual([10, 10, 10, 10, 10, 10, 10, 10, 10, 10]);
  });

  it('ignores non-finite values and values outside [lo,hi]', () => {
    const arr = new Float32Array([-5, 0, NaN, Infinity, 5, 9, 100]);
    const counts = histogram([arr], 10, 0, 10, CAP); // keep 0,5,9 (100 is > hi)
    expect(counts.reduce((a, b) => a + b, 0)).toBe(3);
    expect(counts[0]).toBe(1); // 0 -> bin 0
    expect(counts[5]).toBe(1); // 5 -> bin 5
    expect(counts[9]).toBe(1); // 9 -> bin 9
  });

  it('clamps the right edge (v === hi) into the last bucket', () => {
    const counts = histogram([new Float32Array([10])], 10, 0, 10, CAP);
    expect(counts[9]).toBe(1);
    expect(counts.length).toBe(10);
  });

  it('combines values across arrays', () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([9, 9]);
    const counts = histogram([a, b], 2, 0, 10, CAP);
    expect(Array.from(counts)).toEqual([3, 2]);
  });

  it('returns all-zero counts on a collapsed/invalid domain', () => {
    expect(Array.from(histogram([new Float32Array([5, 5])], 4, 5, 5, CAP))).toEqual([0, 0, 0, 0]);
    expect(Array.from(histogram([new Float32Array([5])], 4, 10, 0, CAP))).toEqual([0, 0, 0, 0]);
  });

  it('subsamples with a stride past the cap', () => {
    const arr = Float32Array.from({ length: 1000 }, () => 5); // all in bin for [0,10)
    const counts = histogram([arr], 10, 0, 10, 100); // cap forces stride=10 -> ~100 sampled
    const total = counts.reduce((a, b) => a + b, 0);
    expect(total).toBe(100);
    expect(counts[5]).toBe(100); // 5 -> bin 5
  });
});
