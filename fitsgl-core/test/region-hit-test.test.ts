import { describe, it, expect } from 'vitest';
import { pointInRect, pointInPolygon, pointInRegion, pickRegion } from '../src/overlay/region-hit-test.js';
import { GridIndex } from '../src/overlay/spatial-index.js';
import { resolveRect, resolvePolygon, type ResolvedRegion, type ResolvedStyle } from '../src/overlay/regions.js';

const STYLE: ResolvedStyle = { fill: [0, 0, 0, 0], stroke: [1, 1, 1, 1], strokeWidth: 1, dashOn: 0, dashOff: 0, data: {} };

function worldRect(x: number, y: number, w: number, h: number, rot = 0, id = 'r'): ResolvedRegion {
  return resolveRect({ x: x - 0.5, y: y - 0.5, width: w, height: h, rotationDeg: rot }, null, STYLE, id) as ResolvedRegion;
}
function worldPoly(pts: Array<[number, number]>, id = 'p'): ResolvedRegion {
  return resolvePolygon({ worldVertices: pts.map(([x, y]) => ({ x: x - 0.5, y: y - 0.5 })) }, null, STYLE, id) as ResolvedRegion;
}

describe('pointInRect', () => {
  it('tests an axis-aligned rectangle', () => {
    const r = worldRect(0, 0, 4, 2) as Extract<ResolvedRegion, { shape: 'rect' }>;
    expect(pointInRect(r, 0, 0)).toBe(true);
    expect(pointInRect(r, 1.9, 0.9)).toBe(true);
    expect(pointInRect(r, 2.1, 0)).toBe(false); // outside half-width 2
    expect(pointInRect(r, 0, 1.1)).toBe(false); // outside half-height 1
  });

  it('respects rotation (a 45° square)', () => {
    const r = worldRect(0, 0, 2, 2, 45) as Extract<ResolvedRegion, { shape: 'rect' }>;
    // Rotated square of half-diagonal √2: the axis tips reach ~(±√2, 0)/(0, ±√2).
    expect(pointInRect(r, 1.3, 0)).toBe(true); // near the rotated tip, still inside
    expect(pointInRect(r, 0.99, 0.99)).toBe(false); // an original corner is now outside
  });
});

describe('pointInPolygon', () => {
  it('tests a convex square', () => {
    const p = worldPoly([[0, 0], [4, 0], [4, 4], [0, 4]]) as Extract<ResolvedRegion, { shape: 'polygon' }>;
    expect(pointInPolygon(p, 2, 2)).toBe(true);
    expect(pointInPolygon(p, -0.1, 2)).toBe(false);
    expect(pointInPolygon(p, 5, 2)).toBe(false);
  });

  it('excludes the notch of a concave polygon', () => {
    // An arrowhead pointing right; the concave vertex (2,2) carves a notch on the
    // left, so points near the tip are inside and points behind the notch are not.
    const p = worldPoly([[0, 0], [4, 2], [0, 4], [2, 2]]) as Extract<ResolvedRegion, { shape: 'polygon' }>;
    expect(pointInPolygon(p, 3, 2)).toBe(true); // inside the body, near the tip
    expect(pointInPolygon(p, 0.5, 2)).toBe(false); // in the notch, outside
  });
});

describe('pickRegion', () => {
  it('returns the topmost (highest-index) region under the point', () => {
    const regions = [worldRect(0, 0, 4, 4, 0, 'under'), worldRect(0, 0, 4, 4, 0, 'over')];
    const picked = pickRegion([0, 1], regions, 0, 0);
    expect(picked?.id).toBe('over');
  });

  it('returns null when the point is in no candidate', () => {
    const regions = [worldRect(0, 0, 2, 2)];
    expect(pickRegion([0], regions, 10, 10)).toBeNull();
  });

  it('mixes shapes', () => {
    const regions = [worldRect(-5, 0, 2, 2, 0, 'rect'), worldPoly([[3, 3], [7, 3], [5, 7]], 'tri')];
    expect(pickRegion([0, 1], regions, -5, 0)?.id).toBe('rect');
    expect(pickRegion([0, 1], regions, 5, 4)?.id).toBe('tri');
  });
});

describe('broad-phase superset (grid vs brute oracle)', () => {
  it('never culls a region whose body contains the query point', () => {
    // A field of assorted rects + polygons.
    const regions: ResolvedRegion[] = [];
    let maxBound = 0;
    for (let i = 0; i < 200; i++) {
      const cx = (i * 37) % 100;
      const cy = (i * 53) % 100;
      const r =
        i % 3 === 0
          ? worldPoly([[cx, cy], [cx + 3, cy], [cx + 3, cy + 4], [cx, cy + 4]], `p${i}`)
          : worldRect(cx, cy, 2 + (i % 5), 2 + (i % 3), (i * 11) % 360, `r${i}`);
      regions.push(r);
      if (r.boundRadius > maxBound) maxBound = r.boundRadius;
    }
    const grid = new GridIndex(regions.map((r) => ({ x: r.centerX, y: r.centerY })));

    for (let q = 0; q < 500; q++) {
      const wx = (q * 7.3) % 105 - 2;
      const wy = (q * 9.7) % 105 - 2;
      const candidates = new Set(grid.query(wx, wy, maxBound));
      for (let i = 0; i < regions.length; i++) {
        if (pointInRegion(regions[i], wx, wy)) {
          expect(candidates.has(i)).toBe(true); // the grid must not cull a true hit
        }
      }
    }
  });
});
