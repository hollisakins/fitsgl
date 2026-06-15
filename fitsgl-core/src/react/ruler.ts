/**
 * Ruler / measure-tool overlay for the explorer (Phase 2 of the cloud-DS9 work).
 *
 * The first consumer of the Phase 0 pointer-tool seam: a `PointerTool` (installed
 * by `<FitsExplorer>` via `setTool`) drives the two endpoints; this module owns the
 * derived measurement and the Canvas2D drawing. Mirrors `graticule.ts` — a pure
 * draw over a Canvas2D layer stacked on the GL canvas, reprojected each frame from
 * the viewer's public accessors (`getWcs`/`imageToScreen`) so the line and its
 * label stay glued to the sky under pan/zoom/North-up. Endpoints are stored in
 * world (native image-pixel) coords; sky distance + position angle come from
 * `pixToSky` + the spherical-trig helpers.
 */

import { pixToSky, angularSeparationDeg, positionAngleDeg, formatSeparation } from '../index.js';
import type { FitsViewerCore } from './index.js';

/** A point in world (native image-pixel) coordinates. */
interface Point {
  x: number;
  y: number;
}

/** The derived measurement for a two-point ruler (WCS-independent pixel distance
 *  always; sky separation + PA only when the band carries a usable WCS). */
export interface RulerMeasurement {
  /** Straight native-pixel distance between the endpoints. */
  pixelDist: number;
  /** Great-circle separation in DEGREES, or null when there is no WCS. */
  sepDeg: number | null;
  /** Position angle in degrees (North→East) at the first endpoint, or null. */
  paDeg: number | null;
}

/** A ruler's full live state: its two world endpoints, whether the drag is still
 *  in progress, and the derived measurement. Held in the readout store (per-drag
 *  high frequency) so only the overlay + status leaf re-render. */
export interface RulerGeometry extends RulerMeasurement {
  a: Point;
  b: Point;
  dragging: boolean;
}

/**
 * Measure a two-point ruler. Pure: the pixel distance is a plain hypot on the world
 * coords (correct for any non-square / rotated CD, unlike deriving it from the
 * angular separation); the sky separation + position angle come from each endpoint's
 * `pixToSky` when a WCS is present. `wcs` is the parsed `TanWcs` or null.
 */
export function measureRuler(
  wcs: Parameters<typeof pixToSky>[0] | null,
  a: Point,
  b: Point,
): RulerMeasurement {
  const pixelDist = Math.hypot(b.x - a.x, b.y - a.y);
  if (wcs === null) return { pixelDist, sepDeg: null, paDeg: null };
  const sa = pixToSky(wcs, a.x, a.y);
  const sb = pixToSky(wcs, b.x, b.y);
  return { pixelDist, sepDeg: angularSeparationDeg(sa, sb), paDeg: positionAngleDeg(sa, sb) };
}

const LINE = 'rgba(255,214,107,0.96)'; // warm gold — distinct from the bluish graticule
const HALO = 'rgba(0,0,0,0.55)'; // dark outline so the line reads over bright pixels

/** Redraw the ruler into `canvas` for the viewer's current view. Clears and returns
 *  early when there is no canvas/viewer/geometry or the view is degenerate. */
export function drawRuler(
  canvas: HTMLCanvasElement | null,
  viewer: FitsViewerCore | null,
  ruler: RulerGeometry | null,
): void {
  if (canvas === null) return;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const W = Math.max(1, Math.round(rect.width * dpr));
  const H = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;
  ctx.clearRect(0, 0, W, H);
  if (viewer === null || ruler === null || !(rect.width > 0)) return;

  const toLocal = (wx: number, wy: number): { x: number; y: number } => {
    const c = viewer.imageToScreen(wx, wy);
    return { x: (c.x - rect.left) * dpr, y: (c.y - rect.top) * dpr };
  };
  const p0 = toLocal(ruler.a.x, ruler.a.y);
  const p1 = toLocal(ruler.b.x, ruler.b.y);
  if (![p0.x, p0.y, p1.x, p1.y].every(Number.isFinite)) return;

  // The connecting line: a dark halo first, then the gold stroke over it.
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(p0.x, p0.y);
  ctx.lineTo(p1.x, p1.y);
  ctx.lineWidth = Math.max(2.5, dpr * 3.2);
  ctx.strokeStyle = HALO;
  ctx.stroke();
  ctx.lineWidth = Math.max(1, dpr * 1.4);
  ctx.strokeStyle = LINE;
  ctx.stroke();

  // Endpoint dots.
  for (const p of [p0, p1]) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, Math.max(2.5, dpr * 2.6), 0, Math.PI * 2);
    ctx.fillStyle = LINE;
    ctx.fill();
    ctx.lineWidth = Math.max(1, dpr);
    ctx.strokeStyle = HALO;
    ctx.stroke();
  }

  // Two-line label (separation + PA, or pixel distance when there is no WCS),
  // boxed for legibility and clamped inside the canvas.
  const lines =
    ruler.sepDeg !== null
      ? [formatSeparation(ruler.sepDeg), `PA ${(ruler.paDeg ?? 0).toFixed(1)}°  ${ruler.pixelDist.toFixed(0)} px`]
      : [`${ruler.pixelDist.toFixed(1)} px`];
  ctx.font = `${Math.round(11 * dpr)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.textBaseline = 'top';
  const padX = 5 * dpr;
  const padY = 3 * dpr;
  const lh = Math.round(13 * dpr);
  const tw = Math.max(...lines.map((l) => ctx.measureText(l).width));
  const bw = tw + padX * 2;
  const bh = lh * lines.length + padY * 2;
  const mx = (p0.x + p1.x) / 2;
  const my = (p0.y + p1.y) / 2;
  let bx = mx - bw / 2;
  let by = my - bh - 9 * dpr;
  bx = Math.min(Math.max(bx, 2 * dpr), W - bw - 2 * dpr);
  by = Math.min(Math.max(by, 2 * dpr), H - bh - 2 * dpr);
  ctx.fillStyle = 'rgba(10,14,22,0.82)';
  ctx.fillRect(bx, by, bw, bh);
  ctx.fillStyle = 'rgba(255,225,160,0.98)';
  lines.forEach((l, i) => ctx.fillText(l, bx + padX, by + padY + i * lh));
}
