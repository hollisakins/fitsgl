/**
 * Rect-region instance-buffer packing (issue #16) — pure, the single source of
 * truth for the interleaved layout the instanced rect draw consumes. The
 * `vertexAttribPointer` offsets in `region-renderer.ts` MUST match the constants
 * here; `region-pack.test.ts` pins them so a desync fails a test rather than
 * silently mis-rendering.
 *
 * Only rectangles are instanced (a field can carry thousands of MSA shutters);
 * polygons take a separate, per-shape path (`polygon.ts`).
 *
 * Layout — 19 floats / instance, stride 76 bytes, one contiguous vec per
 * attribute (a vertex attribute holds at most a vec4):
 *
 *   float offset  attribute        contents
 *   0..1          a_center  vec2   centre x, y (world / native px)
 *   2..3          a_half    vec2   half-width, half-height (world px)
 *   4..5          a_axisU   vec2   unit +width axis direction (world)
 *   6..7          a_axisV   vec2   unit +height axis direction (world)
 *   8..11         a_fill    vec4   fill r, g, b, a in [0,1]
 *   12..15        a_stroke  vec4   stroke r, g, b, a in [0,1]
 *   16..18        a_style   vec3   strokeWidth, dashOn, dashOff (all CSS px)
 *
 * Centres/axes are always finite here (the store only holds placeable regions).
 */

import type { ResolvedRect } from './regions.js';

/** Floats per rect instance. */
export const REGION_INSTANCE_FLOATS = 19;
/** Interleaved stride in bytes. */
export const REGION_INSTANCE_STRIDE_BYTES = REGION_INSTANCE_FLOATS * 4;

export const R_OFFSET_CENTER = 0;
export const R_OFFSET_HALF = 2;
export const R_OFFSET_AXISU = 4;
export const R_OFFSET_AXISV = 6;
export const R_OFFSET_FILL = 8;
export const R_OFFSET_STROKE = 12;
export const R_OFFSET_STYLE = 16;

/** Write one rect's 19 floats into `out` starting at float index `base`. */
function writeRect(out: Float32Array, base: number, r: ResolvedRect): void {
  out[base + R_OFFSET_CENTER] = r.centerX;
  out[base + R_OFFSET_CENTER + 1] = r.centerY;
  out[base + R_OFFSET_HALF] = r.halfW;
  out[base + R_OFFSET_HALF + 1] = r.halfH;
  out[base + R_OFFSET_AXISU] = r.axisU[0];
  out[base + R_OFFSET_AXISU + 1] = r.axisU[1];
  out[base + R_OFFSET_AXISV] = r.axisV[0];
  out[base + R_OFFSET_AXISV + 1] = r.axisV[1];
  out[base + R_OFFSET_FILL] = r.fill[0];
  out[base + R_OFFSET_FILL + 1] = r.fill[1];
  out[base + R_OFFSET_FILL + 2] = r.fill[2];
  out[base + R_OFFSET_FILL + 3] = r.fill[3];
  out[base + R_OFFSET_STROKE] = r.stroke[0];
  out[base + R_OFFSET_STROKE + 1] = r.stroke[1];
  out[base + R_OFFSET_STROKE + 2] = r.stroke[2];
  out[base + R_OFFSET_STROKE + 3] = r.stroke[3];
  out[base + R_OFFSET_STYLE] = r.strokeWidth;
  out[base + R_OFFSET_STYLE + 1] = r.dashOn;
  out[base + R_OFFSET_STYLE + 2] = r.dashOff;
}

/** Pack all rects into one interleaved `Float32Array` (`count * REGION_INSTANCE_FLOATS`). */
export function packRects(rects: readonly ResolvedRect[]): Float32Array {
  const out = new Float32Array(rects.length * REGION_INSTANCE_FLOATS);
  for (let i = 0; i < rects.length; i++) writeRect(out, i * REGION_INSTANCE_FLOATS, rects[i]);
  return out;
}

/** Pack a single rect's 19 floats — the slice an O(1) restyle re-uploads. */
export function packRectOne(rect: ResolvedRect): Float32Array {
  const out = new Float32Array(REGION_INSTANCE_FLOATS);
  writeRect(out, 0, rect);
  return out;
}
