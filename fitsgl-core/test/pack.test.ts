import { describe, it, expect } from 'vitest';
import {
  packInstances,
  packOne,
  INSTANCE_FLOATS,
  INSTANCE_STRIDE_BYTES,
  OFFSET_CENTER,
  OFFSET_STYLE,
  OFFSET_COLOR,
} from '../src/overlay/pack.js';
import { SHAPE_IDS, type ResolvedMarker } from '../src/overlay/markers.js';

function marker(over: Partial<ResolvedMarker>): ResolvedMarker {
  return {
    id: 'm',
    x: 0,
    y: 0,
    ra: null,
    dec: null,
    shape: 'circle',
    size: 12,
    color: [1, 0.8, 0, 1],
    edgeWidth: 1.5,
    data: {},
    ...over,
  };
}

describe('instance packing — the byte-layout source of truth', () => {
  it('pins the stride/offset constants the VAO pointers depend on', () => {
    // overlay-renderer.ts vertexAttribPointer uses exactly these; a change here
    // that desyncs them must fail a test, not silently mis-render.
    expect(INSTANCE_FLOATS).toBe(9);
    expect(INSTANCE_STRIDE_BYTES).toBe(36);
    expect(OFFSET_CENTER).toBe(0);
    expect(OFFSET_STYLE).toBe(2);
    expect(OFFSET_COLOR).toBe(5);
  });

  it('packOne writes each field at its documented offset', () => {
    const m = marker({ x: 7, y: -3, size: 20, shape: 'box', edgeWidth: 2, color: [0.1, 0.2, 0.3, 0.4] });
    const d = packOne(m);
    expect(d.length).toBe(INSTANCE_FLOATS);
    expect(d[OFFSET_CENTER]).toBe(7);
    expect(d[OFFSET_CENTER + 1]).toBe(-3);
    expect(d[OFFSET_STYLE]).toBe(20);
    expect(d[OFFSET_STYLE + 1]).toBe(SHAPE_IDS.box);
    expect(d[OFFSET_STYLE + 2]).toBe(2);
    expect(d[OFFSET_COLOR]).toBeCloseTo(0.1, 6);
    expect(d[OFFSET_COLOR + 1]).toBeCloseTo(0.2, 6);
    expect(d[OFFSET_COLOR + 2]).toBeCloseTo(0.3, 6);
    expect(d[OFFSET_COLOR + 3]).toBeCloseTo(0.4, 6);
  });

  it('packInstances interleaves markers contiguously', () => {
    const a = marker({ id: 'a', x: 1, y: 2, shape: 'point' });
    const b = marker({ id: 'b', x: 3, y: 4, shape: 'circle' });
    const data = packInstances([a, b]);
    expect(data.length).toBe(2 * INSTANCE_FLOATS);
    expect(data[0 * INSTANCE_FLOATS + OFFSET_CENTER]).toBe(1);
    expect(data[0 * INSTANCE_FLOATS + OFFSET_STYLE + 1]).toBe(SHAPE_IDS.point);
    expect(data[1 * INSTANCE_FLOATS + OFFSET_CENTER]).toBe(3);
    expect(data[1 * INSTANCE_FLOATS + OFFSET_STYLE + 1]).toBe(SHAPE_IDS.circle);
  });

  it('produces an empty array for no markers', () => {
    expect(packInstances([]).length).toBe(0);
  });
});
