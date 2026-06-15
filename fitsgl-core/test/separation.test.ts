import { describe, it, expect } from 'vitest';
import { angularSeparationDeg, positionAngleDeg } from '../src/wcs/separation.js';
import { formatSeparation } from '../src/wcs/format.js';
import type { SkyCoord } from '../src/wcs/tan.js';

const at = (ra: number, dec: number): SkyCoord => ({ ra, dec });

/** Independent reference haversine (degrees) — the oracle for the helper. */
function refSepDeg(a: SkyCoord, b: SkyCoord): number {
  const d = Math.PI / 180;
  const sh = Math.sin(((b.dec - a.dec) * d) / 2);
  const sa = Math.sin(((b.ra - a.ra) * d) / 2);
  const hav = sh * sh + Math.cos(a.dec * d) * Math.cos(b.dec * d) * sa * sa;
  return (2 * Math.asin(Math.min(1, Math.sqrt(hav)))) / d;
}

describe('angularSeparationDeg', () => {
  it('is zero for identical points', () => {
    expect(angularSeparationDeg(at(123.4, -5.6), at(123.4, -5.6))).toBe(0);
  });

  it('measures a 1° meridian step exactly', () => {
    expect(angularSeparationDeg(at(0, 0), at(0, 1))).toBeCloseTo(1, 10);
  });

  it('measures a 1° equatorial step exactly', () => {
    expect(angularSeparationDeg(at(0, 0), at(1, 0))).toBeCloseTo(1, 10);
  });

  it('is robust to the 0/360 RA wrap', () => {
    // 359.5° → 0.5° is a 1° hop across the seam, not a 359° one.
    expect(angularSeparationDeg(at(359.5, 0), at(0.5, 0))).toBeCloseTo(1, 10);
  });

  it('converges with cos(dec) away from the equator', () => {
    // A 2° RA step at dec 60° subtends ≈ 2·cos60° = 1° on the sky (slightly under,
    // by the great-circle curvature). Pin to the reference, and sanity-check the ≈1°.
    const sep = angularSeparationDeg(at(0, 60), at(2, 60));
    expect(sep).toBeCloseTo(refSepDeg(at(0, 60), at(2, 60)), 9);
    expect(sep).toBeCloseTo(1, 2);
    expect(sep).toBeLessThan(1); // strictly less than the flat 2·cos(dec) estimate
  });

  it('measures antipodal points as 180°', () => {
    expect(angularSeparationDeg(at(0, 0), at(180, 0))).toBeCloseTo(180, 8);
  });

  it('is symmetric and matches the reference across scattered points', () => {
    const pts: SkyCoord[] = [
      at(10, 20),
      at(10.001, 20.0005),
      at(280, -75),
      at(0.1, 89.9),
      at(359.99, -0.02),
    ];
    for (const a of pts)
      for (const b of pts) {
        expect(angularSeparationDeg(a, b)).toBeCloseTo(refSepDeg(a, b), 9);
        expect(angularSeparationDeg(a, b)).toBeCloseTo(angularSeparationDeg(b, a), 12);
      }
  });
});

describe('positionAngleDeg', () => {
  it('points due north for a +Dec step (PA 0)', () => {
    expect(positionAngleDeg(at(0, 0), at(0, 1))).toBeCloseTo(0, 8);
    expect(positionAngleDeg(at(0, 45), at(0, 46))).toBeCloseTo(0, 8);
  });

  it('points due east for a +RA step (PA 90)', () => {
    expect(positionAngleDeg(at(0, 0), at(1, 0))).toBeCloseTo(90, 8);
  });

  it('points due south for a −Dec step (PA 180)', () => {
    expect(positionAngleDeg(at(0, 0), at(0, -1))).toBeCloseTo(180, 8);
  });

  it('points due west for a −RA step (PA 270)', () => {
    expect(positionAngleDeg(at(0, 0), at(359, 0))).toBeCloseTo(270, 8);
  });

  it('returns a value in [0, 360)', () => {
    const pa = positionAngleDeg(at(30, -10), at(31, -9));
    expect(pa).toBeGreaterThanOrEqual(0);
    expect(pa).toBeLessThan(360);
  });
});

describe('formatSeparation', () => {
  it('uses arcseconds below 1′', () => {
    expect(formatSeparation(1 / 3600)).toBe('1.00″');
    expect(formatSeparation(0.5 / 3600)).toBe('0.50″');
    expect(formatSeparation(59 / 3600)).toBe('59.00″');
  });

  it('uses arcminutes between 1′ and 1°', () => {
    expect(formatSeparation(120 / 3600)).toBe('2.00′');
    expect(formatSeparation(1800 / 3600)).toBe('30.00′');
  });

  it('uses degrees at and above 1°', () => {
    expect(formatSeparation(1)).toBe('1.000°');
    expect(formatSeparation(2.5)).toBe('2.500°');
  });

  it('collapses a non-finite separation to the placeholder', () => {
    expect(formatSeparation(NaN)).toBe('—');
    expect(formatSeparation(Infinity)).toBe('—');
  });
});
