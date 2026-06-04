import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { gridsMatch, GRID_MATCH_SUBPIXEL_FRACTION, type GridSpec } from '../src/wcs/grid-match.js';

interface Case {
  name: string;
  a: { wcs: Record<string, unknown>; shape: [number, number] };
  b: { wcs: Record<string, unknown>; shape: [number, number] };
  match: boolean;
}

const FIX_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = JSON.parse(
  readFileSync(join(FIX_DIR, 'grid_fixtures.json'), 'utf8'),
) as { subpixel_fraction: number; cases: Case[] };

const spec = (c: { wcs: Record<string, unknown>; shape: [number, number] }): GridSpec => ({
  wcs: c.wcs,
  shape: c.shape,
});

describe('gridsMatch — composite compatibility (astropy fixtures, M4/D7)', () => {
  it('uses the sub-pixel fraction the fixtures were generated with', () => {
    expect(GRID_MATCH_SUBPIXEL_FRACTION).toBe(fixture.subpixel_fraction);
  });

  for (const c of fixture.cases) {
    it(`${c.name} -> ${c.match ? 'match' : 'no match'}`, () => {
      expect(gridsMatch(spec(c.a), spec(c.b))).toBe(c.match);
    });

    it(`${c.name} is symmetric`, () => {
      expect(gridsMatch(spec(c.b), spec(c.a))).toBe(c.match);
    });
  }
});

describe('gridsMatch — invariants', () => {
  const ref = fixture.cases.find((c) => c.name === 'identical');
  if (ref === undefined) throw new Error('fixture missing the identical case');

  it('exact integer shape is required even when WCS agrees', () => {
    // The "off_by_one_shape_same_wcs" fixture asserts this against astropy; here
    // pin it directly so the exact-shape rule cannot be loosened to a tolerance.
    expect(gridsMatch({ wcs: ref.a.wcs, shape: [512, 512] }, { wcs: ref.a.wcs, shape: [512, 511] })).toBe(false);
    expect(gridsMatch({ wcs: ref.a.wcs, shape: [512, 512] }, { wcs: ref.a.wcs, shape: [511, 512] })).toBe(false);
  });

  it('a band reflexively matches itself', () => {
    expect(gridsMatch(spec(ref.a), spec(ref.a))).toBe(true);
  });

  it('two WCS-less bands match on shape alone; mixing WCS with WCS-less does not', () => {
    expect(gridsMatch({ wcs: {}, shape: [100, 100] }, { wcs: {}, shape: [100, 100] })).toBe(true);
    expect(gridsMatch({ wcs: {}, shape: [100, 100] }, { wcs: {}, shape: [100, 101] })).toBe(false);
    expect(gridsMatch({ wcs: ref.a.wcs, shape: ref.a.shape }, { wcs: {}, shape: ref.a.shape })).toBe(false);
  });

  it('rejects a half-pixel offset even on a sub-milli-arcsec/px grid (scale-relative tolerance)', () => {
    // 1 mas/px: a half-pixel offset is 0.5 mas = 5e-4″ — BELOW the old fixed
    // 1e-3″ tolerance (which would falsely match), but 10× the sub-pixel
    // fraction, so the scale-relative gate correctly rejects it.
    const s = 0.001 / 3600; // 1 mas/px, in deg/px
    const wcs = (crpix1: number): Record<string, unknown> => ({
      CTYPE1: 'RA---TAN',
      CTYPE2: 'DEC--TAN',
      CRPIX1: crpix1,
      CRPIX2: 256.5,
      CRVAL1: 150,
      CRVAL2: 2.2,
      CD1_1: -s,
      CD1_2: 0,
      CD2_1: 0,
      CD2_2: s,
    });
    expect(gridsMatch({ wcs: wcs(256.5), shape: [512, 512] }, { wcs: wcs(256.5), shape: [512, 512] })).toBe(true);
    expect(gridsMatch({ wcs: wcs(256.5), shape: [512, 512] }, { wcs: wcs(257.0), shape: [512, 512] })).toBe(false);
  });
});
