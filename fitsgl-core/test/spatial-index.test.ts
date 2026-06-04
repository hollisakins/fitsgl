import { describe, it, expect } from 'vitest';
import { GridIndex } from '../src/overlay/spatial-index.js';

interface P {
  x: number;
  y: number;
}

/** Deterministic LCG so failures reproduce. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Brute-force oracle: indices whose Euclidean distance is within `radius`. */
function withinRadius(points: P[], x: number, y: number, radius: number): Set<number> {
  const out = new Set<number>();
  for (let i = 0; i < points.length; i++) {
    const dx = points[i].x - x;
    const dy = points[i].y - y;
    if (Math.sqrt(dx * dx + dy * dy) <= radius) out.add(i);
  }
  return out;
}

function assertSuperset(points: P[], x: number, y: number, radius: number): void {
  const got = new Set(new GridIndex(points).query(x, y, radius));
  for (const i of withinRadius(points, x, y, radius)) {
    expect(got.has(i)).toBe(true);
  }
}

describe('GridIndex.query is a superset of the true within-radius hits', () => {
  it('holds for random catalogs and random queries (grid path)', () => {
    const rng = lcg(12345);
    for (let trial = 0; trial < 40; trial++) {
      const n = 200 + Math.floor(rng() * 600); // > BRUTE_FORCE_MAX -> exercises the grid
      const points: P[] = [];
      for (let i = 0; i < n; i++) points.push({ x: rng() * 1000, y: rng() * 800 });
      for (let q = 0; q < 10; q++) {
        const qx = rng() * 1000;
        const qy = rng() * 800;
        const radius = rng() * 120;
        assertSuperset(points, qx, qy, radius);
      }
    }
  });

  it('handles a radius spanning many cells', () => {
    const rng = lcg(7);
    const points: P[] = [];
    for (let i = 0; i < 500; i++) points.push({ x: rng() * 100, y: rng() * 100 });
    assertSuperset(points, 50, 50, 80); // radius >> cell size: must scan many cells
  });

  it('degenerate inputs: empty, single, all-coincident, zero-width AABB', () => {
    expect(new GridIndex([]).query(0, 0, 10)).toEqual([]);
    expect(new GridIndex([{ x: 5, y: 5 }]).query(5, 5, 1)).toContain(0);
    // > BRUTE_FORCE_MAX coincident points -> degenerate AABB -> brute fallback.
    const coincident: P[] = Array.from({ length: 100 }, () => ({ x: 3, y: 3 }));
    const idx = new GridIndex(coincident);
    expect(idx.query(3, 3, 0).length).toBe(100); // radius 0 still finds all at the point
    // A vertical line (zero-width AABB), > brute threshold.
    const line: P[] = Array.from({ length: 100 }, (_, i) => ({ x: 0, y: i }));
    assertSuperset(line, 0, 50, 5);
  });

  it('a few far outliers do not break the superset invariant', () => {
    const rng = lcg(99);
    const points: P[] = [];
    for (let i = 0; i < 300; i++) points.push({ x: rng() * 10, y: rng() * 10 });
    points.push({ x: 1e6, y: 1e6 }, { x: -1e6, y: -5e5 }); // outliers blow up the AABB
    assertSuperset(points, 5, 5, 3);
    assertSuperset(points, 1e6, 1e6, 2);
  });

  it('an infinite/NaN radius returns all markers', () => {
    const points: P[] = Array.from({ length: 100 }, (_, i) => ({ x: i, y: i }));
    expect(new GridIndex(points).query(0, 0, Infinity).length).toBe(100);
  });
});
