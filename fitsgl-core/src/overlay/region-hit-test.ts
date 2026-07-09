/**
 * Region hit-testing (issue #16) — pure, no GL/DOM. The narrow phase of picking.
 *
 * Unlike markers (tiny screen-sized glyphs, so their exact test is in screen space
 * with a few-px slop), a region is a world-space AREA: a hit is simply the pointer
 * landing inside the footprint, tested in world coordinates. That makes the test
 * orientation/zoom-independent and needs no screen projection — an outline-only
 * region (no fill) is still clickable across its whole interior.
 *
 * Broad phase reuses the marker `GridIndex` over region CENTRES; the viewer queries
 * it with the store's max bound-radius so the grid can never cull a region whose
 * body covers the cursor while its centre sits outside the query box.
 * `region-hit-test.test.ts` pins the superset relationship against a brute oracle.
 */

import type { RegionShape, ResolvedPolygon, ResolvedRect, ResolvedRegion } from './regions.js';

/** Whether world point `(wx, wy)` lies inside a rotated rectangle. */
export function pointInRect(rect: ResolvedRect, wx: number, wy: number): boolean {
  const dx = wx - rect.centerX;
  const dy = wy - rect.centerY;
  const u = dx * rect.axisU[0] + dy * rect.axisU[1];
  const v = dx * rect.axisV[0] + dy * rect.axisV[1];
  return Math.abs(u) <= rect.halfW && Math.abs(v) <= rect.halfH;
}

/** Whether world point `(wx, wy)` lies inside a polygon (even-odd ray cast). */
export function pointInPolygon(poly: ResolvedPolygon, wx: number, wy: number): boolean {
  const vs = poly.worldVertices;
  let inside = false;
  for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
    const yi = vs[i].y;
    const yj = vs[j].y;
    // A ray toward +x crosses edge (j→i) iff the edge straddles the scanline y=wy.
    const straddles = yi > wy !== yj > wy;
    if (straddles) {
      const xCross = vs[j].x + ((wy - yj) / (yi - yj)) * (vs[i].x - vs[j].x);
      if (wx < xCross) inside = !inside;
    }
  }
  return inside;
}

/** Whether world point `(wx, wy)` lies inside a region of either shape. */
export function pointInRegion(region: ResolvedRegion, wx: number, wy: number): boolean {
  return region.shape === 'rect' ? pointInRect(region, wx, wy) : pointInPolygon(region, wx, wy);
}

/**
 * A region's z-order key for picking, matching `RegionRenderer.draw`'s PAINT order
 * (all rects first, then all polygons; within a shape, later store index paints on
 * top). So polygons rank above rects regardless of store index, and the topmost
 * *painted* region under the cursor is the candidate with the largest key. Keeping
 * this in lockstep with the draw order is what makes the clicked/hovered region the
 * one the user actually sees on top when a rect and a polygon overlap.
 */
function paintKey(shape: RegionShape, index: number, count: number): number {
  return (shape === 'polygon' ? count : 0) + index; // index < count → the two bands are disjoint
}

/**
 * The topmost region (by paint order) containing the world point, among
 * `candidates` (store indices from the broad phase), or null.
 */
export function pickRegion(
  candidates: readonly number[],
  regions: readonly ResolvedRegion[],
  wx: number,
  wy: number,
): ResolvedRegion | null {
  let best: ResolvedRegion | null = null;
  let bestKey = -1;
  for (const i of candidates) {
    const r = regions[i];
    if (r === undefined) continue;
    const key = paintKey(r.shape, i, regions.length);
    if (key <= bestKey) continue;
    if (pointInRegion(r, wx, wy)) {
      best = r;
      bestKey = key;
    }
  }
  return best;
}
