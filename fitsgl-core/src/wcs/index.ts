/**
 * WCS module — client-side TAN (gnomonic) pixel<->sky for ICRS (M2, decision D4).
 *
 * Foundational and dependency-free: no GL, no astropy. The renderer's RA/Dec
 * readout, North-up orientation, and (M3) catalog overlays all call through
 * here. Correctness is gated against astropy fixtures in `wcs.test.ts`.
 */

export { parseWcs, pixToSky, skyToPix } from './tan.js';
export type { TanWcs, SkyCoord, PixelCoord } from './tan.js';
export { formatRA, formatDec } from './format.js';

// M4 — grid compatibility for RGB compositing (the authoritative same-grid gate).
export { gridsMatch, GRID_MATCH_SUBPIXEL_FRACTION } from './grid-match.js';
export type { GridSpec } from './grid-match.js';
