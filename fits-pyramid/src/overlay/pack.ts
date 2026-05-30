/**
 * Marker instance-buffer packing (M3) — pure, the single source of truth for the
 * interleaved layout the WebGL instanced draw consumes. `overlay-renderer.ts`'s
 * `vertexAttribPointer` offsets MUST match the constants here, and `pack.test.ts`
 * pins them so a layout edit that desyncs the two fails a test rather than
 * silently mis-rendering.
 *
 * Layout — 9 floats / instance, stride 36 bytes, grouped so each attribute is a
 * contiguous vec (a vertex attribute holds at most a vec4):
 *
 *   float offset   bytes   attribute        contents
 *   0..1           0       a_center  vec2   centre x, y (world / native px)
 *   2..4           8       a_style   vec3   size (CSS px), shapeId, edgeWidth (CSS px)
 *   5..8           20      a_color   vec4   r, g, b, a in [0,1]
 *
 * Centres are always finite here: the store only holds placeable markers, so no
 * NaN reaches the buffer (a NaN centre would produce a degenerate/discarded quad
 * and a NaN could leak through blending).
 */

import { SHAPE_IDS, type ResolvedMarker } from './markers.js';

/** Floats per instance. */
export const INSTANCE_FLOATS = 9;
/** Interleaved stride in bytes (`INSTANCE_FLOATS * 4`). */
export const INSTANCE_STRIDE_BYTES = INSTANCE_FLOATS * 4;

/** Float offset of `a_center` (vec2) within an instance. */
export const OFFSET_CENTER = 0;
/** Float offset of `a_style` (vec3: size, shapeId, edgeWidth). */
export const OFFSET_STYLE = 2;
/** Float offset of `a_color` (vec4). */
export const OFFSET_COLOR = 5;

/** Write one marker's 9 floats into `out` starting at float index `base`. */
function writeInstance(out: Float32Array, base: number, m: ResolvedMarker): void {
  out[base + OFFSET_CENTER] = m.x;
  out[base + OFFSET_CENTER + 1] = m.y;
  out[base + OFFSET_STYLE] = m.size;
  out[base + OFFSET_STYLE + 1] = SHAPE_IDS[m.shape];
  out[base + OFFSET_STYLE + 2] = m.edgeWidth;
  out[base + OFFSET_COLOR] = m.color[0];
  out[base + OFFSET_COLOR + 1] = m.color[1];
  out[base + OFFSET_COLOR + 2] = m.color[2];
  out[base + OFFSET_COLOR + 3] = m.color[3];
}

/** Pack all markers into one interleaved `Float32Array` (`count * INSTANCE_FLOATS`). */
export function packInstances(markers: readonly ResolvedMarker[]): Float32Array {
  const out = new Float32Array(markers.length * INSTANCE_FLOATS);
  for (let i = 0; i < markers.length; i++) writeInstance(out, i * INSTANCE_FLOATS, markers[i]);
  return out;
}

/** Pack a single marker's 9 floats — the slice an O(1) `updateMarker` re-uploads. */
export function packOne(marker: ResolvedMarker): Float32Array {
  const out = new Float32Array(INSTANCE_FLOATS);
  writeInstance(out, 0, marker);
  return out;
}
