import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseWcs, pixToSky, skyToPix } from '../src/wcs/tan.js';
import { formatRA, formatDec } from '../src/wcs/format.js';

interface Config {
  name: string;
  shape: [number, number];
  wcs: Record<string, unknown>;
  center_world: [number, number];
  p2w: Array<{ x0: number; y0: number; ra: number; dec: number }>;
  w2p: Array<{ ra: number; dec: number; x0: number; y0: number }>;
  north_vec: [number, number];
  east_vec: [number, number];
}

const FIX_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = JSON.parse(
  readFileSync(join(FIX_DIR, 'wcs_fixtures.json'), 'utf8'),
) as { configs: Config[] };

/** Great-circle separation in arcsec (robust to RA wrap and cos(dec)). */
function angularSepArcsec(ra1: number, dec1: number, ra2: number, dec2: number): number {
  const d = Math.PI / 180;
  const a1 = ra1 * d;
  const a2 = ra2 * d;
  const b1 = dec1 * d;
  const b2 = dec2 * d;
  const sinHalfD = Math.sin((b2 - b1) / 2);
  const sinHalfA = Math.sin((a2 - a1) / 2);
  const hav = sinHalfD * sinHalfD + Math.cos(b1) * Math.cos(b2) * sinHalfA * sinHalfA;
  const sep = 2 * Math.asin(Math.min(1, Math.sqrt(hav)));
  return (sep / d) * 3600;
}

describe('TAN pixToSky / skyToPix — matches astropy across configs', () => {
  for (const cfg of fixture.configs) {
    describe(cfg.name, () => {
      const wcs = parseWcs(cfg.wcs);

      it('parses to a supported TAN/ICRS WCS', () => {
        expect(wcs).not.toBeNull();
      });

      it('pixToSky matches astropy pixel_to_world (< 1e-4 arcsec)', () => {
        if (wcs === null) throw new Error('unparsed');
        for (const s of cfg.p2w) {
          // astropy 0-based pixel x0 -> renderer world x0 + 0.5.
          const sky = pixToSky(wcs, s.x0 + 0.5, s.y0 + 0.5);
          const sep = angularSepArcsec(sky.ra, sky.dec, s.ra, s.dec);
          expect(sep).toBeLessThan(1e-4);
          expect(sky.ra).toBeGreaterThanOrEqual(0);
          expect(sky.ra).toBeLessThan(360);
        }
      });

      it('skyToPix matches astropy world_to_pixel (< 1e-8 px, incl. near-pole/RA-wrap)', () => {
        if (wcs === null) throw new Error('unparsed');
        for (const s of cfg.w2p) {
          const px = skyToPix(wcs, s.ra, s.dec);
          expect(Math.abs(px.x - (s.x0 + 0.5))).toBeLessThan(1e-8);
          expect(Math.abs(px.y - (s.y0 + 0.5))).toBeLessThan(1e-8);
        }
      });

      it('pixToSky and skyToPix round-trip (< 1e-8 px)', () => {
        if (wcs === null) throw new Error('unparsed');
        for (const s of cfg.p2w) {
          const sky = pixToSky(wcs, s.x0 + 0.5, s.y0 + 0.5);
          const back = skyToPix(wcs, sky.ra, sky.dec);
          expect(Math.abs(back.x - (s.x0 + 0.5))).toBeLessThan(1e-8);
          expect(Math.abs(back.y - (s.y0 + 0.5))).toBeLessThan(1e-8);
        }
      });
    });
  }
});

describe('parseWcs — rejects unsupported headers', () => {
  it('rejects a non-TAN projection', () => {
    expect(parseWcs({ CTYPE1: 'RA---SIN', CTYPE2: 'DEC--SIN', CRPIX1: 1, CRPIX2: 1, CRVAL1: 0, CRVAL2: 0, CD1_1: 1, CD2_2: 1 })).toBeNull();
  });
  it('rejects an explicit non-ICRS frame', () => {
    expect(parseWcs({ CTYPE1: 'RA---TAN', CTYPE2: 'DEC--TAN', RADESYS: 'FK5', CRPIX1: 1, CRPIX2: 1, CRVAL1: 0, CRVAL2: 0, CD1_1: 1, CD2_2: 1 })).toBeNull();
  });
  it('rejects a singular linear transform', () => {
    expect(parseWcs({ CTYPE1: 'RA---TAN', CTYPE2: 'DEC--TAN', CRPIX1: 1, CRPIX2: 1, CRVAL1: 0, CRVAL2: 0, CD1_1: 0, CD1_2: 0, CD2_1: 0, CD2_2: 0 })).toBeNull();
  });
  it('accepts PC+CDELT with omitted off-diagonal terms (the manifest form)', () => {
    const wcs = parseWcs({
      CTYPE1: 'RA---TAN', CTYPE2: 'DEC--TAN', RADESYS: 'ICRS',
      CRPIX1: 256.5, CRPIX2: 256.5, CRVAL1: 150, CRVAL2: 2.2,
      PC1_1: -8.333e-6, PC2_2: 8.333e-6, CDELT1: 1, CDELT2: 1,
    });
    expect(wcs).not.toBeNull();
    expect(wcs?.cd).toEqual([-8.333e-6, 0, 0, 8.333e-6]);
  });
});

describe('sexagesimal formatting', () => {
  it('formats RA in time units', () => {
    expect(formatRA(150.0)).toBe('10:00:00.000'); // 150 deg = 10h
    expect(formatRA(0.0)).toBe('00:00:00.000');
  });
  it('formats Dec with sign', () => {
    expect(formatDec(2.2)).toBe('+02:12:00.00');
    expect(formatDec(-5.5)).toBe('-05:30:00.00');
  });
  it('carries rounding up through the units (no 60.000s)', () => {
    // 1 deg = 240s of RA-time; just under a 1" RA tick should not print 60.
    expect(formatRA(359.9999999)).toBe('00:00:00.000'); // wraps to 0
    expect(formatDec(-0.00000001)).toBe('+00:00:00.00'); // -0 -> +00 (rounds to zero)
  });
});
