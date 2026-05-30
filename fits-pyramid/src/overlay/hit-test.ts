/**
 * Marker hit-testing (M3) — pure, no GL/DOM. The narrow phase of picking.
 *
 * Glyphs are screen-aligned and screen-sized (a `box` is an upright square of
 * `size` CSS px, a `circle`/`point` a disc of `size` CSS px), so the exact test
 * is done in SCREEN (drawing-buffer) space: project a candidate's world centre
 * through the oriented view transform — the SAME `worldToScreen` the renderer
 * uses — and compare the buffer-pixel cursor against the glyph. Doing it in
 * screen space makes it exact under North-up rotation (a rotated world position
 * but an unrotated on-screen glyph), and keeps the CPU test and the GPU geometry
 * in lockstep.
 *
 * Units: the cursor arrives in drawing-buffer px (the viewer's `toBufferCoords`);
 * `size` is CSS px, so the glyph half-extent is `(size/2 + slop) * dpr` buffer
 * px. The broad-phase world radius here uses the SAME conversion (with the
 * store's max size), so the grid can never cull a marker the narrow phase would
 * accept — `hit-test.test.ts` pins that superset relationship across dpr.
 */

import { worldToScreen, type Mat2, type ViewParams } from '../renderer/view-transform.js';
import { type MarkerShape, type ResolvedMarker } from './markers.js';

/** Extra hit slack in CSS px, so a thin ring/box is comfortably clickable. */
export const HIT_SLOP_CSS = 1;

/** Glyph half-extent (buffer px) for a marker of `sizeCss` at `dpr`. */
export function glyphHalfBuffer(sizeCss: number, dpr: number): number {
  return (sizeCss / 2 + HIT_SLOP_CSS) * dpr;
}

/**
 * Broad-phase world-space query radius for the grid: the largest glyph
 * (`maxSizeCss`) converted to buffer px then to world px (÷ zoom). `zoom` is
 * buffer-px per world-px, so the dpr factor must be applied to the CSS size
 * BEFORE dividing — omitting it under-selects on HiDPI and silently drops edge
 * hits (the bug B6 in the design review).
 */
export function broadPhaseWorldRadius(maxSizeCss: number, dpr: number, zoom: number): number {
  if (!(zoom > 0) || !Number.isFinite(zoom)) return Infinity;
  return glyphHalfBuffer(maxSizeCss, dpr) / zoom;
}

/** Whether a screen-aligned glyph of half-extent `half` (buffer px) contains the offset. */
export function glyphContains(shape: MarkerShape, dxBuf: number, dyBuf: number, half: number): boolean {
  if (shape === 'box') {
    return Math.abs(dxBuf) <= half && Math.abs(dyBuf) <= half;
  }
  // point + circle: hit anywhere inside the bounding disc (so hovering inside a
  // ring still hits, matching what the user perceives as the target).
  return dxBuf * dxBuf + dyBuf * dyBuf <= half * half;
}

/**
 * The topmost marker under the cursor among `candidates` (drawable indices), or
 * null. "Topmost" = the highest index, i.e. the one drawn last / painted on top,
 * so the picked marker matches what the user sees. The cursor is in buffer px.
 * `candidates` is a superset from the grid; this does the exact per-glyph test.
 */
export function pickMarker(
  candidates: readonly number[],
  markers: readonly ResolvedMarker[],
  view: ViewParams,
  orient: Mat2,
  cursorBufX: number,
  cursorBufY: number,
  dpr: number,
): ResolvedMarker | null {
  let best: ResolvedMarker | null = null;
  let bestIndex = -1;
  for (const i of candidates) {
    if (i <= bestIndex) continue; // can't beat the current topmost
    const m = markers[i];
    if (m === undefined) continue;
    const s = worldToScreen(view, orient, m.x, m.y);
    const half = glyphHalfBuffer(m.size, dpr);
    if (glyphContains(m.shape, cursorBufX - s.x, cursorBufY - s.y, half)) {
      best = m;
      bestIndex = i;
    }
  }
  return best;
}

/**
 * Whether a press→release was a click rather than a drag: total pointer travel
 * under `thresholdCss` CSS px. Coordinates are buffer px; the threshold is scaled
 * by dpr so a few-buffer-px jitter on a HiDPI display still counts as a click.
 */
export function wasClick(
  downX: number,
  downY: number,
  upX: number,
  upY: number,
  dpr: number,
  thresholdCss = 3,
): boolean {
  const dx = upX - downX;
  const dy = upY - downY;
  const threshold = thresholdCss * dpr;
  return dx * dx + dy * dy <= threshold * threshold;
}
