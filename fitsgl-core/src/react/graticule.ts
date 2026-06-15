/**
 * RA/Dec coordinate-grid (graticule) drawing for the explorer overlay.
 *
 * Pure drawing over a Canvas2D layer stacked on the GL canvas, driven each frame
 * from the viewer's public coordinate accessors (Phase 0): `getWcs`,
 * `screenToImage` (client→world), `imageToScreen` (world→client). It traces true
 * iso-RA / iso-Dec curves by sampling `skyToPix` along each line, so the grid
 * stays correct under the TAN projection, pan/zoom, and North-up rotation.
 */

import { pixToSky, skyToPix, formatRA, formatDec } from '../index.js';
import type { FitsViewerCore } from './index.js';

/** Candidate tick steps in degrees: 30°…1°, 30′…1′, 30″…1″ (descending). */
const STEPS_DEG = [
  30, 15, 10, 5, 2, 1, 0.5,
  30 / 60, 15 / 60, 10 / 60, 5 / 60, 2 / 60, 1 / 60,
  30 / 3600, 15 / 3600, 10 / 3600, 5 / 3600, 2 / 3600, 1 / 3600,
];

/** The largest "nice" step that yields at least ~`target` ticks across `spanDeg`. */
function niceStep(spanDeg: number, target = 5): number {
  const ideal = spanDeg / target;
  for (const s of STEPS_DEG) if (s <= ideal) return s;
  return STEPS_DEG[STEPS_DEG.length - 1]!;
}

const SAMPLES = 96; // points traced per grid line (smooth under projection curvature)

/** Redraw the graticule into `canvas` for the viewer's current view. Clears and
 *  returns early when there is no canvas/viewer/WCS or the view is degenerate. */
export function drawGraticule(canvas: HTMLCanvasElement | null, viewer: FitsViewerCore | null): void {
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

  const wcs = viewer?.getWcs() ?? null;
  if (viewer === null || wcs === null || !(rect.width > 0)) return;

  const worldToLocal = (wx: number, wy: number): { x: number; y: number } => {
    const c = viewer.imageToScreen(wx, wy);
    return { x: (c.x - rect.left) * dpr, y: (c.y - rect.top) * dpr };
  };

  // Visible sky bbox from the four canvas corners (client px → world → sky).
  let raMin = Infinity;
  let raMax = -Infinity;
  let decMin = Infinity;
  let decMax = -Infinity;
  for (const [cx, cy] of [
    [rect.left, rect.top],
    [rect.right, rect.top],
    [rect.left, rect.bottom],
    [rect.right, rect.bottom],
  ]) {
    const w = viewer.screenToImage(cx, cy);
    const s = pixToSky(wcs, w.x, w.y);
    if (!Number.isFinite(s.ra) || !Number.isFinite(s.dec)) return;
    raMin = Math.min(raMin, s.ra);
    raMax = Math.max(raMax, s.ra);
    decMin = Math.min(decMin, s.dec);
    decMax = Math.max(decMax, s.dec);
  }
  // A huge RA span means we straddle the 0/360 wrap (or look near a pole): skip
  // rather than draw a wrong grid.
  if (raMax - raMin > 180 || decMax - decMin > 90) return;

  const decStep = niceStep(decMax - decMin);
  const raStep = niceStep(raMax - raMin);

  ctx.lineWidth = Math.max(1, dpr * 0.75);
  ctx.strokeStyle = 'rgba(150,200,255,0.26)';
  ctx.fillStyle = 'rgba(190,215,255,0.9)';
  ctx.font = `${Math.round(10.5 * dpr)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.textBaseline = 'alphabetic';

  // Iso-Dec lines (constant Dec, varying RA), labelled at the left edge.
  for (let d = Math.ceil(decMin / decStep) * decStep; d <= decMax; d += decStep) {
    ctx.beginPath();
    for (let i = 0; i <= SAMPLES; i++) {
      const ra = raMin + ((raMax - raMin) * i) / SAMPLES;
      const p = skyToPix(wcs, ra, d);
      const l = worldToLocal(p.x, p.y);
      if (i === 0) ctx.moveTo(l.x, l.y);
      else ctx.lineTo(l.x, l.y);
    }
    ctx.stroke();
    const edge = worldToLocal(...pixOf(skyToPix(wcs, raMin, d)));
    ctx.fillText(formatDec(d, 0), 5 * dpr, edge.y - 4 * dpr);
  }

  // Iso-RA lines (constant RA, varying Dec), labelled at the bottom edge.
  for (let r = Math.ceil(raMin / raStep) * raStep; r <= raMax; r += raStep) {
    ctx.beginPath();
    for (let i = 0; i <= SAMPLES; i++) {
      const dec = decMin + ((decMax - decMin) * i) / SAMPLES;
      const p = skyToPix(wcs, r, dec);
      const l = worldToLocal(p.x, p.y);
      if (i === 0) ctx.moveTo(l.x, l.y);
      else ctx.lineTo(l.x, l.y);
    }
    ctx.stroke();
    const edge = worldToLocal(...pixOf(skyToPix(wcs, r, decMin)));
    ctx.fillText(formatRA(r, 0), edge.x + 4 * dpr, H - 5 * dpr);
  }
}

/** Spread a {x,y} pixel into a [x,y] tuple for `worldToLocal`. */
function pixOf(p: { x: number; y: number }): [number, number] {
  return [p.x, p.y];
}
