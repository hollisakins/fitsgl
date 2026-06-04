/**
 * Grid compatibility for RGB compositing (M4, decisions D7/D9).
 *
 * Two single-band pyramids can be composited into one color image only if they
 * share an identical pixel grid — same array shape AND the same pixel→sky
 * mapping — because the renderer samples all three channels at ONE shared
 * texcoord (the vertex shader has a single `u_uv`/`v_uv`) and does NO in-browser
 * resampling (D7). This module is the AUTHORITATIVE compatibility gate: it
 * verifies that property structurally from each band's parsed WCS + exact shape,
 * reusing the astropy-validated `parseWcs`/`pixToSky` (so no new coordinate
 * engine, D4). It is pure — no GL, no DOM — and unit-tested against
 * astropy-emitted fixtures.
 *
 * The dataset manifest's `gridHash` (written by `fitsgl`) is only a coarse
 * Python-side GROUPING hint for a band picker; it is never the gate, so the
 * client never reproduces that hash byte-for-byte. The gate here is a numeric
 * tolerance compare (no rounding-bucket cliff): exact integer shape, exact
 * CTYPE, and great-circle sky agreement at the four image corners + centre
 * within a small fraction of a pixel.
 */

import { parseWcs, pixToSky, type TanWcs } from './tan.js';

/**
 * Maximum sky disagreement allowed between two bands at a sampled point,
 * expressed as a fraction of a pixel (anchored to the band's own WCS pixel
 * scale, so the gate is resolution-independent). A half-pixel registration
 * offset — the canonical misregistration that would smear a NEAREST composite —
 * is 0.5 px, ten times this threshold, so it is always rejected; genuinely
 * co-gridded bands agree to a tiny fraction of a pixel (≈ float noise) and pass.
 * A fixed *absolute* tolerance would silently false-match a half-pixel offset on
 * a sub-milli-arcsec/px grid — this fraction holds at any scale.
 */
export const GRID_MATCH_SUBPIXEL_FRACTION = 0.05;

/** A band's grid identity: its flat FITS WCS dict and native `[H, W]` shape. */
export interface GridSpec {
  wcs: Record<string, unknown>;
  shape: readonly [number, number];
}

const DEG = Math.PI / 180;

/** Mean pixel scale (arcsec/px) from a CD matrix: √|det(CD)| · 3600. */
function pixelScaleArcsec(wcs: TanWcs): number {
  const [a, b, c, d] = wcs.cd;
  return Math.sqrt(Math.abs(a * d - b * c)) * 3600;
}

/** Great-circle separation in arcsec (robust to RA wrap and cos(dec)). */
function angularSepArcsec(ra1: number, dec1: number, ra2: number, dec2: number): number {
  const a1 = ra1 * DEG;
  const a2 = ra2 * DEG;
  const b1 = dec1 * DEG;
  const b2 = dec2 * DEG;
  const sinHalfD = Math.sin((b2 - b1) / 2);
  const sinHalfA = Math.sin((a2 - a1) / 2);
  const hav = sinHalfD * sinHalfD + Math.cos(b1) * Math.cos(b2) * sinHalfA * sinHalfA;
  const sep = 2 * Math.asin(Math.min(1, Math.sqrt(hav)));
  return (sep / DEG) * 3600;
}

function ctype(wcs: Record<string, unknown>, key: string): string {
  const v = wcs[key];
  return typeof v === 'string' ? v.trim().toUpperCase() : '';
}

/**
 * Whether two bands share a composite-ready grid. Requires:
 *   - exact integer shape equality (never rounded — an off-by-one shape trims to
 *     different per-level tile counts and would silently mis-register coarse
 *     tiles), and
 *   - either both bands lack a usable WCS (then they are aligned by the pixel
 *     grid alone), or both have one with identical CTYPE and sky positions
 *     agreeing at the four corners + centre within `GRID_MATCH_SUBPIXEL_FRACTION`
 *     of a pixel (the threshold is anchored to the finer band's pixel scale).
 *
 * A band with a usable WCS is never matched against one without (one is
 * sky-registered, the other is not — refuse rather than guess).
 */
export function gridsMatch(a: GridSpec, b: GridSpec): boolean {
  // Exact integer shape — the structural precondition for identical tiling.
  if (a.shape[0] !== b.shape[0] || a.shape[1] !== b.shape[1]) return false;

  const wa = parseWcs(a.wcs);
  const wb = parseWcs(b.wcs);
  // Both pixel-only: identical shape ⟹ identical grid (nothing sky to disagree on).
  if (wa === null && wb === null) return true;
  // Exactly one carries sky information — ambiguous, reject.
  if (wa === null || wb === null) return false;

  // Identical projection/axis types.
  if (ctype(a.wcs, 'CTYPE1') !== ctype(b.wcs, 'CTYPE1')) return false;
  if (ctype(a.wcs, 'CTYPE2') !== ctype(b.wcs, 'CTYPE2')) return false;

  // Tolerance is a fraction of a pixel, scaled by the finer band's pixel scale,
  // so a half-pixel offset is rejected at any resolution (not just coarse grids).
  const scale = Math.min(pixelScaleArcsec(wa), pixelScaleArcsec(wb));
  const toleranceArcsec = scale * GRID_MATCH_SUBPIXEL_FRACTION;

  const [h, w] = a.shape;
  // World-pixel corners + centre. World coords are 0-based with the imaged area
  // spanning [0, W] × [0, H]; `pixToSky` applies the half-pixel centre shift.
  const samples: ReadonlyArray<readonly [number, number]> = [
    [0, 0],
    [w, 0],
    [0, h],
    [w, h],
    [w / 2, h / 2],
  ];
  for (const [x, y] of samples) {
    const sa = pixToSky(wa, x, y);
    const sb = pixToSky(wb, x, y);
    if (angularSepArcsec(sa.ra, sa.dec, sb.ra, sb.dec) > toleranceArcsec) {
      return false;
    }
  }
  return true;
}
