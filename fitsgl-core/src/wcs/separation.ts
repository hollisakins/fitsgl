/**
 * Great-circle separation and on-sky position angle between two ICRS points.
 *
 * Pure spherical trig, no deps — the measure-tool (ruler) and the RGB grid gate
 * both reduce to "how far apart, and in which direction, are these two sky
 * positions". Operates on `SkyCoord` (degrees), decoupled from pixels: a caller
 * converts cursor positions through `pixToSky` first. Correctness is gated in
 * `separation.test.ts` (and, transitively, the astropy-fixture grid-match tests
 * that route through `angularSeparationDeg`).
 */

import type { SkyCoord } from './tan.js';

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/**
 * Great-circle (haversine) separation in DEGREES between two ICRS points. Robust
 * to the 0/360 RA wrap and the cos(dec) convergence near the poles — a naïve flat
 * `Δ(ra,dec)` metric is wrong at both. Symmetric: `sep(a,b) === sep(b,a)`.
 */
export function angularSeparationDeg(a: SkyCoord, b: SkyCoord): number {
  const d1 = a.dec * DEG2RAD;
  const d2 = b.dec * DEG2RAD;
  const sinHalfDec = Math.sin((d2 - d1) / 2);
  const sinHalfRa = Math.sin(((b.ra - a.ra) * DEG2RAD) / 2);
  const hav = sinHalfDec * sinHalfDec + Math.cos(d1) * Math.cos(d2) * sinHalfRa * sinHalfRa;
  return 2 * Math.asin(Math.min(1, Math.sqrt(hav))) * RAD2DEG;
}

/**
 * On-sky position angle in DEGREES (`[0, 360)`), measured AT point `a` from North
 * (+Dec) toward East (+RA) — the standard astronomical convention, matching the
 * renderer's North-up framing (North=+Dec, East=+RA). Direction-dependent:
 * `pa(a,b) !== pa(b,a)`, so `a` is the vertex (the ruler's first click). Uses the
 * `atan2` form rather than `asin` so it stays well-conditioned near the poles.
 */
export function positionAngleDeg(a: SkyCoord, b: SkyCoord): number {
  const d1 = a.dec * DEG2RAD;
  const d2 = b.dec * DEG2RAD;
  const dRa = (b.ra - a.ra) * DEG2RAD;
  const y = Math.cos(d2) * Math.sin(dRa);
  const x = Math.cos(d1) * Math.sin(d2) - Math.sin(d1) * Math.cos(d2) * Math.cos(dRa);
  const pa = Math.atan2(y, x) * RAD2DEG;
  return ((pa % 360) + 360) % 360;
}
