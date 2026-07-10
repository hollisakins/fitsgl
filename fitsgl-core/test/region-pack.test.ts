import { describe, it, expect } from 'vitest';
import {
  packRects,
  packRectOne,
  REGION_INSTANCE_FLOATS,
  REGION_INSTANCE_STRIDE_BYTES,
  R_OFFSET_CENTER,
  R_OFFSET_HALF,
  R_OFFSET_AXISU,
  R_OFFSET_AXISV,
  R_OFFSET_FILL,
  R_OFFSET_STROKE,
  R_OFFSET_STYLE,
} from '../src/overlay/region-pack.js';
import { resolveRect, type ResolvedRect, type ResolvedStyle } from '../src/overlay/regions.js';

const STYLE: ResolvedStyle = {
  fill: [0.1, 0.2, 0.3, 0.4],
  stroke: [0.5, 0.6, 0.7, 0.8],
  strokeWidth: 2,
  dashOn: 6,
  dashOff: 4,
  data: {},
};

function rect(): ResolvedRect {
  // world rect: centre (10, 20), half (4, 2), axis-aligned.
  return resolveRect({ x: 9.5, y: 19.5, width: 8, height: 4 }, null, STYLE, 'a') as ResolvedRect;
}

describe('region-pack layout', () => {
  it('pins the interleaved layout constants', () => {
    expect(REGION_INSTANCE_FLOATS).toBe(19);
    expect(REGION_INSTANCE_STRIDE_BYTES).toBe(76);
    // Offsets are contiguous, non-overlapping vecs.
    expect([R_OFFSET_CENTER, R_OFFSET_HALF, R_OFFSET_AXISU, R_OFFSET_AXISV, R_OFFSET_FILL, R_OFFSET_STROKE, R_OFFSET_STYLE])
      .toEqual([0, 2, 4, 6, 8, 12, 16]);
  });

  it('packOne writes exactly the 19 floats at the pinned offsets', () => {
    const r = rect();
    const s = packRectOne(r);
    expect(s.length).toBe(REGION_INSTANCE_FLOATS);
    expect([s[R_OFFSET_CENTER], s[R_OFFSET_CENTER + 1]]).toEqual([10, 20]);
    expect([s[R_OFFSET_HALF], s[R_OFFSET_HALF + 1]]).toEqual([4, 2]);
    expect(s[R_OFFSET_AXISU]).toBeCloseTo(1, 6);
    expect(s[R_OFFSET_AXISV + 1]).toBeCloseTo(1, 6);
    expect(s[R_OFFSET_FILL]).toBeCloseTo(0.1, 6);
    expect(s[R_OFFSET_FILL + 3]).toBeCloseTo(0.4, 6);
    expect(s[R_OFFSET_STROKE]).toBeCloseTo(0.5, 6);
    expect(s[R_OFFSET_STROKE + 3]).toBeCloseTo(0.8, 6);
    expect([s[R_OFFSET_STYLE], s[R_OFFSET_STYLE + 1], s[R_OFFSET_STYLE + 2]]).toEqual([2, 6, 4]);
  });

  it('packRects concatenates instances contiguously', () => {
    const r = rect();
    const all = packRects([r, r, r]);
    expect(all.length).toBe(3 * REGION_INSTANCE_FLOATS);
    // The third instance's centre lands at its stride offset.
    const base = 2 * REGION_INSTANCE_FLOATS;
    expect([all[base + R_OFFSET_CENTER], all[base + R_OFFSET_CENTER + 1]]).toEqual([10, 20]);
  });

  it('packRects of an empty list is empty', () => {
    expect(packRects([]).length).toBe(0);
  });
});
