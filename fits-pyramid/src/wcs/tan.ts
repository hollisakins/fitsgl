/**
 * TAN (gnomonic) WCS — pixel <-> sky, ICRS only (decision D4).
 *
 * The browser does its own coordinate math from the per-level `wcs` dict in the
 * manifest (a flat FITS WCS header). v1.0 supports the one projection the
 * pipeline emits: `RA---TAN` / `DEC--TAN` with an ICRS frame. There is no
 * astropy on the client — this is a direct, dependency-free implementation of
 * the FITS WCS pipeline (Greisen & Calabretta 2002, Papers I & II), validated
 * bit-for-bit against astropy fixtures in `wcs.test.ts`.
 *
 * Pixel conventions. CRPIX is FITS 1-based (pixel (1,1) is the centre of the
 * first pixel). The renderer's *world* coordinates are 0-based with integer
 * boundaries — the centre of world pixel k sits at world `k + 0.5` (see the tile
 * texture mapping). So a world coordinate `w` is FITS pixel `w + 0.5`, and
 * astropy's 0-based `pixel_to_world(x, 0)` argument is `w - 0.5`. All public
 * functions here take and return *world* coordinates; the half-pixel shift is
 * applied internally so callers never deal with it.
 *
 * Pure math: no GL, no DOM. The scaling at z=0 is the identity, so the z=0
 * level's `wcs` dict is the native WCS and world pixels map through it directly.
 */

const DEG = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/** A parsed TAN WCS in a form ready for the projection math. */
export interface TanWcs {
  /** Reference pixel, FITS 1-based. */
  crpix1: number;
  crpix2: number;
  /** Reference world coordinate (deg), ICRS. */
  crval1: number;
  crval2: number;
  /** Linear transform (deg/pixel), row-major [cd11, cd12, cd21, cd22]. */
  cd: readonly [number, number, number, number];
  /** Inverse of `cd` (pixel/deg), cached for skyToPix. */
  cdInv: readonly [number, number, number, number];
  /** Native longitude of the celestial pole (deg); TAN default 180. */
  lonpole: number;
}

export interface SkyCoord {
  /** Right ascension, ICRS, degrees in [0, 360). */
  ra: number;
  /** Declination, ICRS, degrees in [-90, 90]. */
  dec: number;
}

export interface PixelCoord {
  /** World (native-pixel) coordinates, 0-based with half-pixel centres. */
  x: number;
  y: number;
}

function num(dict: Record<string, unknown>, key: string): number | undefined {
  const v = dict[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function str(dict: Record<string, unknown>, key: string): string {
  const v = dict[key];
  return typeof v === 'string' ? v : '';
}

/** Invert a 2×2 [a,b,c,d]; returns null if singular. */
function invert2x2(
  m: readonly [number, number, number, number],
): [number, number, number, number] | null {
  const [a, b, c, d] = m;
  const det = a * d - b * c;
  if (!Number.isFinite(det) || det === 0) return null;
  return [d / det, -b / det, -c / det, a / det];
}

/**
 * Parse a flat FITS WCS header dict into a `TanWcs`, or return null if it is not
 * a supported 2-axis ICRS TAN WCS. Accepts the CD matrix or the PC+CDELT
 * representation (the pipeline's `WCS.to_header()` emits PC+CDELT), applying the
 * FITS defaults: PCi_i = 1, PCi_j = 0 (i≠j), CDELTi = 1, missing CDi_j = 0.
 */
export function parseWcs(dict: Record<string, unknown>): TanWcs | null {
  const ctype1 = str(dict, 'CTYPE1').toUpperCase();
  const ctype2 = str(dict, 'CTYPE2').toUpperCase();
  // Require RA on axis 1, DEC on axis 2, both TAN. (Swapped-axis WCS is rare and
  // out of scope for v1.0.)
  if (!(ctype1.startsWith('RA--') && ctype1.endsWith('TAN'))) return null;
  if (!(ctype2.startsWith('DEC-') && ctype2.endsWith('TAN'))) return null;

  // Frame: support ICRS (the pipeline emits RADESYS=ICRS). Treat an absent
  // RADESYS as ICRS-compatible; reject explicit non-ICRS frames.
  const radesys = str(dict, 'RADESYS').toUpperCase();
  if (radesys !== '' && radesys !== 'ICRS') return null;

  // Angular units must be degrees (the only unit the pipeline writes).
  for (const k of ['CUNIT1', 'CUNIT2'] as const) {
    const u = str(dict, k).trim().toLowerCase();
    if (u !== '' && u !== 'deg' && u !== 'degree' && u !== 'degrees') return null;
  }

  const crpix1 = num(dict, 'CRPIX1');
  const crpix2 = num(dict, 'CRPIX2');
  const crval1 = num(dict, 'CRVAL1');
  const crval2 = num(dict, 'CRVAL2');
  if (crpix1 === undefined || crpix2 === undefined) return null;
  if (crval1 === undefined || crval2 === undefined) return null;

  // Linear transform: prefer an explicit CD matrix; otherwise PC × CDELT.
  let cd: [number, number, number, number];
  const hasCd =
    num(dict, 'CD1_1') !== undefined ||
    num(dict, 'CD1_2') !== undefined ||
    num(dict, 'CD2_1') !== undefined ||
    num(dict, 'CD2_2') !== undefined;
  if (hasCd) {
    cd = [
      num(dict, 'CD1_1') ?? 0,
      num(dict, 'CD1_2') ?? 0,
      num(dict, 'CD2_1') ?? 0,
      num(dict, 'CD2_2') ?? 0,
    ];
  } else {
    const cdelt1 = num(dict, 'CDELT1') ?? 1;
    const cdelt2 = num(dict, 'CDELT2') ?? 1;
    const pc11 = num(dict, 'PC1_1') ?? 1;
    const pc12 = num(dict, 'PC1_2') ?? 0;
    const pc21 = num(dict, 'PC2_1') ?? 0;
    const pc22 = num(dict, 'PC2_2') ?? 1;
    cd = [cdelt1 * pc11, cdelt1 * pc12, cdelt2 * pc21, cdelt2 * pc22];
  }
  const cdInv = invert2x2(cd);
  if (cdInv === null) return null;

  // FITS default for a zenithal projection (TAN, theta0 = 90°): phi_p = 0 when
  // the reference point is at/above the celestial pole (CRVAL2 >= 90), else 180
  // (Calabretta & Greisen 2002, Paper II eq. 8). astropy's to_header always
  // writes an explicit LONPOLE, so this fallback only matters for hand-authored
  // headers — but getting it wrong there flips the field 180° about the pole.
  const lonpole = num(dict, 'LONPOLE') ?? (crval2 >= 90 ? 0 : 180);

  return { crpix1, crpix2, crval1, crval2, cd, cdInv, lonpole };
}

/** Normalize an angle in degrees to [0, 360). */
function normDeg360(deg: number): number {
  const r = deg % 360;
  return r < 0 ? r + 360 : r;
}

/**
 * World (native-pixel) coordinates -> ICRS sky. Implements intermediate-world
 * coords (CD · pixel offset), TAN deprojection, and the native->celestial
 * spherical rotation for a zenithal projection (native pole = reference point).
 */
export function pixToSky(wcs: TanWcs, worldX: number, worldY: number): SkyCoord {
  // World -> FITS 1-based pixel, then offset from the reference pixel.
  const u = worldX + 0.5 - wcs.crpix1;
  const v = worldY + 0.5 - wcs.crpix2;

  // Intermediate world coordinates (projection plane), degrees.
  const [c11, c12, c21, c22] = wcs.cd;
  const x = c11 * u + c12 * v;
  const y = c21 * u + c22 * v;

  // TAN deprojection -> native spherical (phi, theta), radians.
  const r = Math.hypot(x, y); // degrees
  const phi = Math.atan2(x, -y);
  const theta = Math.atan2(RAD2DEG, r); // r_theta = (180/pi) cot(theta)

  // Native -> celestial. For zenithal projections the native pole coincides with
  // the reference point (crval1, crval2); phi_p = LONPOLE.
  const ap = wcs.crval1 * DEG;
  const dp = wcs.crval2 * DEG;
  const phip = wcs.lonpole * DEG;
  const dphi = phi - phip;
  const sinT = Math.sin(theta);
  const cosT = Math.cos(theta);
  const sinDp = Math.sin(dp);
  const cosDp = Math.cos(dp);
  const cosDphi = Math.cos(dphi);

  // sinDec, and the two cosDec·{cos,sin}(ra-ap) terms. Use atan2(sinDec,
  // hypot(rx, ry)) rather than asin(sinDec): asin has infinite slope at ±1, so
  // near a celestial pole (sinDec -> ±1) it loses precision — the same trap
  // skyToPix avoids with hypot. hypot(rx, ry) == cosDec exactly.
  const sinDec = sinT * sinDp + cosT * cosDp * cosDphi;
  const ry = -cosT * Math.sin(dphi);
  const rx = sinT * cosDp - cosT * sinDp * cosDphi;
  const dec = Math.atan2(sinDec, Math.hypot(rx, ry));
  const ra = ap + Math.atan2(ry, rx);

  return { ra: normDeg360(ra * RAD2DEG), dec: dec * RAD2DEG };
}

/**
 * ICRS sky -> world (native-pixel) coordinates. Inverse of `pixToSky`: inverse
 * spherical rotation (celestial->native), TAN projection (native->plane), then
 * CD^-1 to pixel offsets. Coordinates outside the projection's valid hemisphere
 * (theta <= 0) are still returned via the gnomonic formula but lose meaning at
 * the antipode; callers pass on-sky positions.
 */
export function skyToPix(wcs: TanWcs, ra: number, dec: number): PixelCoord {
  const ar = ra * DEG;
  const dr = dec * DEG;
  const ap = wcs.crval1 * DEG;
  const dp = wcs.crval2 * DEG;
  const phip = wcs.lonpole * DEG;
  const dalpha = ar - ap;

  const sinD = Math.sin(dr);
  const cosD = Math.cos(dr);
  const sinDp = Math.sin(dp);
  const cosDp = Math.cos(dp);
  const cosDa = Math.cos(dalpha);

  // Celestial -> native (phi, theta). `a` and `b` are cosTheta·sin/cos(phi-phip).
  const a = -cosD * Math.sin(dalpha);
  const b = sinD * cosDp - cosD * sinDp * cosDa;
  const sinTheta = sinD * sinDp + cosD * cosDp * cosDa;
  // cosTheta from hypot(a, b) — NOT asin(sinTheta). At/near the reference point
  // sinTheta rounds to 1.0 and asin has infinite slope there, so asin(sinTheta)
  // would lose ~8 digits; hypot is exact (cosTheta = 0 at the reference).
  const cosTheta = Math.hypot(a, b);
  const phi = phip + Math.atan2(a, b);

  // Native -> projection plane (TAN): r_theta = (180/pi) cot(theta), degrees.
  const r = (RAD2DEG * cosTheta) / sinTheta;
  const x = r * Math.sin(phi);
  const y = -r * Math.cos(phi);

  // Projection plane -> pixel offsets via CD^-1, then to world coordinates.
  const [i11, i12, i21, i22] = wcs.cdInv;
  const u = i11 * x + i12 * y;
  const v = i21 * x + i22 * y;
  return { x: u + wcs.crpix1 - 0.5, y: v + wcs.crpix2 - 0.5 };
}
