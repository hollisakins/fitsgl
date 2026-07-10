/**
 * Polygon geometry (issue #16) — pure, no GL/DOM. Triangulation for the fill pass
 * and expanded-edge geometry for the stroke pass, both consumed by
 * `region-renderer.ts`. Polygons are few (footprints), so these run on every
 * set/update; the buffer layouts are pinned by `polygon.test.ts`.
 */

import type { ResolvedPolygon, RegionPoint } from './regions.js';

// ---- fill buffer layout -----------------------------------------------------
/** Floats per fill vertex: `a_pos` (vec2 world) + `a_color` (vec4). */
export const FILL_VERTEX_FLOATS = 6;
export const FILL_OFFSET_POS = 0;
export const FILL_OFFSET_COLOR = 2;

// ---- stroke buffer layout ---------------------------------------------------
/** Floats per stroke vertex: a_a, a_b, a_param(t,side), a_arc(sA,sB), a_color, a_style. */
export const STROKE_VERTEX_FLOATS = 15;
export const STROKE_OFFSET_A = 0;
export const STROKE_OFFSET_B = 2;
export const STROKE_OFFSET_PARAM = 4;
export const STROKE_OFFSET_ARC = 6;
export const STROKE_OFFSET_COLOR = 8;
export const STROKE_OFFSET_STYLE = 12;

/** Twice the signed area of a polygon (>0 for CCW winding in a y-down frame). */
export function signedArea2(verts: readonly RegionPoint[]): number {
  let a = 0;
  for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
    a += verts[j].x * verts[i].y - verts[i].x * verts[j].y;
  }
  return a;
}

function cross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function pointInTriangle(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): boolean {
  const d1 = cross(px, py, ax, ay, bx, by);
  const d2 = cross(px, py, bx, by, cx, cy);
  const d3 = cross(px, py, cx, cy, ax, ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/**
 * Ear-clipping triangulation of a simple polygon. Returns a flat index list
 * (triples into `verts`) with a consistent orientation. Falls back to a triangle
 * fan for the remaining vertices if no ear is found (a self-intersecting or
 * near-degenerate input) so it always returns a covering set rather than throwing.
 */
export function triangulate(verts: readonly RegionPoint[]): number[] {
  const n = verts.length;
  const out: number[] = [];
  if (n < 3) return out;

  // Work on a CCW copy of the index ring (ear test below assumes CCW).
  const ccw = signedArea2(verts) > 0;
  const idx: number[] = [];
  for (let i = 0; i < n; i++) idx.push(ccw ? i : n - 1 - i);

  let guard = 0;
  const maxGuard = n * n + 1;
  while (idx.length > 3 && guard++ < maxGuard) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const i0 = idx[(i + idx.length - 1) % idx.length];
      const i1 = idx[i];
      const i2 = idx[(i + 1) % idx.length];
      const a = verts[i0];
      const b = verts[i1];
      const c = verts[i2];
      // Convex corner? (CCW ring → positive cross)
      if (cross(a.x, a.y, b.x, b.y, c.x, c.y) <= 0) continue;
      // No other vertex inside the candidate ear.
      let hasInside = false;
      for (let k = 0; k < idx.length; k++) {
        const ik = idx[k];
        if (ik === i0 || ik === i1 || ik === i2) continue;
        if (pointInTriangle(verts[ik].x, verts[ik].y, a.x, a.y, b.x, b.y, c.x, c.y)) {
          hasInside = true;
          break;
        }
      }
      if (hasInside) continue;
      out.push(i0, i1, i2);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break; // degenerate: fan the remainder below
  }
  // Fan whatever is left (the normal exit leaves exactly 3; a degenerate input
  // may leave more — a fan still covers it).
  for (let i = 1; i + 1 < idx.length; i++) out.push(idx[0], idx[i], idx[i + 1]);
  return out;
}

/** Build the interleaved fill buffer (world triangles + per-vertex fill colour). */
export function buildPolygonFill(polys: readonly ResolvedPolygon[]): Float32Array {
  const tris: number[][] = [];
  let total = 0;
  for (const p of polys) {
    const t = p.fill[3] > 0 ? triangulate(p.worldVertices) : [];
    tris.push(t);
    total += t.length;
  }
  const out = new Float32Array(total * FILL_VERTEX_FLOATS);
  let o = 0;
  polys.forEach((p, pi) => {
    const t = tris[pi];
    for (const vi of t) {
      const v = p.worldVertices[vi];
      out[o + FILL_OFFSET_POS] = v.x;
      out[o + FILL_OFFSET_POS + 1] = v.y;
      out[o + FILL_OFFSET_COLOR] = p.fill[0];
      out[o + FILL_OFFSET_COLOR + 1] = p.fill[1];
      out[o + FILL_OFFSET_COLOR + 2] = p.fill[2];
      out[o + FILL_OFFSET_COLOR + 3] = p.fill[3];
      o += FILL_VERTEX_FLOATS;
    }
  });
  return out;
}

/** Number of stroke vertices a polygon contributes: 6 per closed edge. */
function strokeVertexCount(p: ResolvedPolygon): number {
  return p.stroke[3] > 0 && p.strokeWidth > 0 ? p.worldVertices.length * 6 : 0;
}

/**
 * Build the interleaved stroke buffer: for each closed edge A→B, a 6-vertex quad
 * (two triangles) carrying both endpoints, the (t, side) selector, the cumulative
 * world arc-length at A/B, and the style — everything the stroke vertex shader
 * needs to expand and dash the edge in screen space.
 */
export function buildPolygonStroke(polys: readonly ResolvedPolygon[]): Float32Array {
  let total = 0;
  for (const p of polys) total += strokeVertexCount(p);
  const out = new Float32Array(total * STROKE_VERTEX_FLOATS);
  let o = 0;

  // The 6 vertices of an edge quad: (t, side) selectors for two triangles.
  const CORNERS: ReadonlyArray<readonly [number, number]> = [
    [0, -1],
    [0, 1],
    [1, -1],
    [1, 1],
    [1, -1],
    [0, 1],
  ];

  for (const p of polys) {
    if (strokeVertexCount(p) === 0) continue;
    const vs = p.worldVertices;
    const n = vs.length;
    // Cumulative world arc-length around the closed loop.
    const arc: number[] = new Array(n + 1);
    arc[0] = 0;
    for (let i = 0; i < n; i++) {
      const a = vs[i];
      const b = vs[(i + 1) % n];
      arc[i + 1] = arc[i] + Math.hypot(b.x - a.x, b.y - a.y);
    }
    for (let i = 0; i < n; i++) {
      const a = vs[i];
      const b = vs[(i + 1) % n];
      const sA = arc[i];
      const sB = arc[i + 1];
      for (const [t, side] of CORNERS) {
        out[o + STROKE_OFFSET_A] = a.x;
        out[o + STROKE_OFFSET_A + 1] = a.y;
        out[o + STROKE_OFFSET_B] = b.x;
        out[o + STROKE_OFFSET_B + 1] = b.y;
        out[o + STROKE_OFFSET_PARAM] = t;
        out[o + STROKE_OFFSET_PARAM + 1] = side;
        out[o + STROKE_OFFSET_ARC] = sA;
        out[o + STROKE_OFFSET_ARC + 1] = sB;
        out[o + STROKE_OFFSET_COLOR] = p.stroke[0];
        out[o + STROKE_OFFSET_COLOR + 1] = p.stroke[1];
        out[o + STROKE_OFFSET_COLOR + 2] = p.stroke[2];
        out[o + STROKE_OFFSET_COLOR + 3] = p.stroke[3];
        out[o + STROKE_OFFSET_STYLE] = p.strokeWidth;
        out[o + STROKE_OFFSET_STYLE + 1] = p.dashOn;
        out[o + STROKE_OFFSET_STYLE + 2] = p.dashOff;
        o += STROKE_VERTEX_FLOATS;
      }
    }
  }
  return out;
}
