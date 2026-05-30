import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  applyStretch,
  scaleValue,
  isStretchMode,
  STRETCH_MODES,
  STRETCH_MODE_IDS,
  LOG_SOFTENING,
  ASINH_SOFTENING,
} from '../src/renderer/stretch.js';
import { TILE_FRAG } from '../src/renderer/shaders/tile.frag.js';

interface StretchFixture {
  log_softening: number;
  asinh_softening: number;
  samples: Array<{ x: number; log: number; asinh: number }>;
}

const FIX_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = JSON.parse(
  readFileSync(join(FIX_DIR, 'stretch_fixtures.json'), 'utf8'),
) as StretchFixture;

describe('applyStretch — matches astropy.visualization golden values', () => {
  it('uses the same fixed softening constants the fixtures were generated with (D5)', () => {
    expect(LOG_SOFTENING).toBe(fixture.log_softening);
    expect(ASINH_SOFTENING).toBe(fixture.asinh_softening);
  });

  it('reproduces LogStretch(a=1000) within float precision', () => {
    for (const s of fixture.samples) {
      expect(Math.abs(applyStretch(s.x, 'log') - s.log)).toBeLessThan(1e-9);
    }
  });

  it('reproduces AsinhStretch(a=0.1) within float precision', () => {
    for (const s of fixture.samples) {
      expect(Math.abs(applyStretch(s.x, 'asinh') - s.asinh)).toBeLessThan(1e-9);
    }
  });

  it('linear is the identity', () => {
    for (const s of fixture.samples) {
      expect(applyStretch(s.x, 'linear')).toBe(s.x);
    }
  });

  it('every mode fixes the endpoints f(0)=0, f(1)=1 (so clamping the input bounds the output)', () => {
    for (const mode of STRETCH_MODES) {
      expect(applyStretch(0, mode)).toBe(0);
      expect(applyStretch(1, mode)).toBeCloseTo(1, 12);
    }
  });

  it('is monotonic non-decreasing on [0,1] for the non-linear curves', () => {
    for (const mode of ['log', 'asinh'] as const) {
      let prev = -Infinity;
      for (let i = 0; i <= 100; i++) {
        const y = applyStretch(i / 100, mode);
        expect(y).toBeGreaterThanOrEqual(prev);
        prev = y;
      }
    }
  });
});

describe('scaleValue — interval + clamp + stretch', () => {
  it('linear scaleValue equals the clamped normalized value', () => {
    const lo = -3;
    const hi = 7;
    for (const v of [-10, -3, 0, 2, 7, 99]) {
      const expected = Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
      expect(scaleValue(v, lo, hi, 'linear')).toBeCloseTo(expected, 12);
    }
  });

  it('clamps out-of-range inputs to the curve endpoints', () => {
    for (const mode of STRETCH_MODES) {
      expect(scaleValue(-100, 0, 10, mode)).toBe(0); // below lo -> f(0) = 0
      expect(scaleValue(1000, 0, 10, mode)).toBeCloseTo(1, 12); // above hi -> f(1) = 1
    }
  });

  it('a non-linear stretch lifts mid-low values above the linear ramp', () => {
    // asinh/log are designed to brighten faint signal: f(x) > x for small x.
    expect(scaleValue(1, 0, 10, 'log')).toBeGreaterThan(scaleValue(1, 0, 10, 'linear'));
    expect(scaleValue(1, 0, 10, 'asinh')).toBeGreaterThan(scaleValue(1, 0, 10, 'linear'));
  });

  it('matches the GLSL clamp on a degenerate (hi == lo) range', () => {
    // Callers pass hi > lo; pin the documented fallback the shader's clamp also
    // produces so the contract is explicit (+Inf -> 1, -Inf -> 0, 0/0 -> NaN).
    expect(scaleValue(10, 5, 5, 'linear')).toBe(1);
    expect(scaleValue(0, 5, 5, 'linear')).toBe(0);
    expect(Number.isNaN(scaleValue(5, 5, 5, 'linear'))).toBe(true);
  });
});

describe('stretch mode metadata', () => {
  it('ids are the linear/log/asinh branch order in the shader', () => {
    expect(STRETCH_MODE_IDS).toEqual({ linear: 0, log: 1, asinh: 2 });
  });
  it('isStretchMode is a correct guard', () => {
    for (const m of STRETCH_MODES) expect(isStretchMode(m)).toBe(true);
    expect(isStretchMode('sqrt')).toBe(false);
    expect(isStretchMode('')).toBe(false);
  });
});

describe('TILE_FRAG shader — structure + constant injection', () => {
  it('inlines the same softening constants as stretch.ts (no drift)', () => {
    expect(TILE_FRAG).toContain(`LOG_A = ${LOG_SOFTENING}.0`);
    expect(TILE_FRAG).toContain(`ASINH_A = ${ASINH_SOFTENING}`);
  });

  it('couples each stretch-mode id to the correct GLSL curve and mirrors scaleValue', () => {
    // The GLSL is the one transfer path golden tests cannot reach (no headless
    // WebGL2), so pin the id<->curve mapping and the normalize/clamp formula
    // against the tested TS reference. Catches a swapped branch or edited body.
    const log1 = TILE_FRAG.indexOf('u_stretchMode == 1');
    const asinh2 = TILE_FRAG.indexOf('u_stretchMode == 2');
    expect(log1).toBeGreaterThan(-1);
    expect(asinh2).toBeGreaterThan(log1);
    const logBody = TILE_FRAG.indexOf('log(LOG_A * norm + 1.0)');
    const asinhBody = TILE_FRAG.indexOf('asinh(norm / ASINH_A)');
    // branch 1 body is log (sits between `== 1` and `== 2`); branch 2 is asinh.
    expect(logBody).toBeGreaterThan(log1);
    expect(logBody).toBeLessThan(asinh2);
    expect(asinhBody).toBeGreaterThan(asinh2);
    // The interval+clamp matches scaleValue's `min(1, max(0, (v-lo)/(hi-lo)))`.
    expect(TILE_FRAG).toContain('clamp((v - lo) / (hi - lo), 0.0, 1.0)');
  });

  it('declares the mega-shader uniform branches (D5)', () => {
    for (const u of ['u_mode', 'u_stretchMode', 'u_useColormap', 'u_colormap', 'u_tile']) {
      expect(TILE_FRAG).toContain(u);
    }
  });

  it('carries the RGB composite slot for M4 (D5) with the D8 NaN policy', () => {
    for (const u of ['u_tileG', 'u_tileB', 'u_minRGB', 'u_maxRGB']) {
      expect(TILE_FRAG).toContain(u);
    }
    // D8: all-NaN -> transparent, AND each channel independently falls back to 0.
    expect(TILE_FRAG).toContain('rn && gn && bn');
    expect(TILE_FRAG).toContain('rn ? 0.0 :');
    expect(TILE_FRAG).toContain('gn ? 0.0 :');
    expect(TILE_FRAG).toContain('bn ? 0.0 :');
  });

  it('targets GLSL ES 3.00 with highp (required for R32F range)', () => {
    expect(TILE_FRAG.startsWith('#version 300 es')).toBe(true);
    expect(TILE_FRAG).toContain('precision highp float');
  });
});
