import { describe, it, expect } from 'vitest';
import {
  triangulate,
  signedArea2,
  buildPolygonFill,
  buildPolygonStroke,
  FILL_VERTEX_FLOATS,
  STROKE_VERTEX_FLOATS,
  STROKE_OFFSET_A,
  STROKE_OFFSET_B,
  STROKE_OFFSET_ARC,
} from '../src/overlay/polygon.js';
import { resolvePolygon, type ResolvedPolygon, type ResolvedStyle, type RegionPoint } from '../src/overlay/regions.js';

const OPAQUE: ResolvedStyle = {
  fill: [1, 0, 0, 0.5],
  stroke: [0, 1, 0, 1],
  strokeWidth: 2,
  dashOn: 0,
  dashOff: 0,
  data: {},
};
const NO_FILL: ResolvedStyle = { ...OPAQUE, fill: [0, 0, 0, 0] };
const NO_STROKE: ResolvedStyle = { ...OPAQUE, stroke: [0, 0, 0, 0] };

function poly(verts: RegionPoint[], style = OPAQUE): ResolvedPolygon {
  return resolvePolygon({ worldVertices: verts.map((v) => ({ x: v.x - 0.5, y: v.y - 0.5 })) }, null, style, 'p') as ResolvedPolygon;
}

/** Sum of triangle areas from a triangulation (should equal the polygon area). */
function triangulatedArea(verts: RegionPoint[]): number {
  const idx = triangulate(verts);
  let a = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const p = verts[idx[i]];
    const q = verts[idx[i + 1]];
    const r = verts[idx[i + 2]];
    a += Math.abs((q.x - p.x) * (r.y - p.y) - (r.x - p.x) * (q.y - p.y)) / 2;
  }
  return a;
}

describe('signedArea2', () => {
  it('is positive for CCW and negative for CW winding', () => {
    const ccw = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }];
    expect(signedArea2(ccw)).toBeGreaterThan(0);
    expect(signedArea2([...ccw].reverse())).toBeLessThan(0);
  });
});

describe('triangulate', () => {
  it('yields n-2 triangles covering a convex polygon', () => {
    const square = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }];
    const idx = triangulate(square);
    expect(idx.length).toBe((square.length - 2) * 3);
    expect(triangulatedArea(square)).toBeCloseTo(16, 9);
  });

  it('covers a concave polygon (area preserved, winding-independent)', () => {
    // An arrow/chevron (concave at vertex 3).
    const concave = [
      { x: 0, y: 0 },
      { x: 4, y: 2 },
      { x: 0, y: 4 },
      { x: 1, y: 2 },
    ];
    expect(triangulatedArea(concave)).toBeCloseTo(Math.abs(signedArea2(concave)) / 2, 9);
    // Reversed winding triangulates to the same total area.
    expect(triangulatedArea([...concave].reverse())).toBeCloseTo(triangulatedArea(concave), 9);
  });

  it('returns nothing for degenerate (< 3) input', () => {
    expect(triangulate([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toEqual([]);
  });
});

describe('buildPolygonFill', () => {
  it('emits 6 floats per triangle vertex with the fill colour', () => {
    const p = poly([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }]);
    const buf = buildPolygonFill([p]);
    expect(buf.length).toBe(2 * 3 * FILL_VERTEX_FLOATS); // 2 triangles
    // First vertex carries the fill rgba in slots 2..5.
    expect([buf[2], buf[3], buf[4], buf[5]]).toEqual([1, 0, expect.closeTo(0, 6), expect.closeTo(0.5, 6)]);
  });

  it('skips a polygon with a transparent fill', () => {
    const p = poly([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 2, y: 4 }], NO_FILL);
    expect(buildPolygonFill([p]).length).toBe(0);
  });
});

describe('buildPolygonStroke', () => {
  it('emits 6 vertices per closed edge with both endpoints and arc-length', () => {
    const verts = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }];
    const p = poly(verts);
    const buf = buildPolygonStroke([p]);
    expect(buf.length).toBe(verts.length * 6 * STROKE_VERTEX_FLOATS); // 4 edges

    // First edge: A=(0,0) B=(4,0), arc-length 0 -> 4.
    expect([buf[STROKE_OFFSET_A], buf[STROKE_OFFSET_A + 1]]).toEqual([0, 0]);
    expect([buf[STROKE_OFFSET_B], buf[STROKE_OFFSET_B + 1]]).toEqual([4, 0]);
    expect([buf[STROKE_OFFSET_ARC], buf[STROKE_OFFSET_ARC + 1]]).toEqual([0, 4]);

    // The closing edge (index 3) runs from (0,4) back to (0,0); its start arc is
    // the perimeter up to that vertex (4 + 4 + 4 = 12).
    const edge3 = 3 * 6 * STROKE_VERTEX_FLOATS;
    expect([buf[edge3 + STROKE_OFFSET_A], buf[edge3 + STROKE_OFFSET_A + 1]]).toEqual([0, 4]);
    expect(buf[edge3 + STROKE_OFFSET_ARC]).toBeCloseTo(12, 9);
  });

  it('skips a polygon with no stroke', () => {
    const p = poly([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 2, y: 4 }], NO_STROKE);
    expect(buildPolygonStroke([p]).length).toBe(0);
  });
});
