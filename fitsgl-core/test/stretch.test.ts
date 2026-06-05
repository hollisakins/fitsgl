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
  trilogyCurve,
  solveTrilogyK,
  saturationValue,
  trilogyLevels,
  combineTrilogyLuminance,
  trilogyLevelsForBands,
  rainbowWeights,
  hsvToRgb,
  weightedTrilogyPixel,
  MAX_BANDS,
  DEFAULT_TRILOGY_PARAMS,
  type TrilogyStats,
  type BandWeight,
} from '../src/renderer/stretch.js';
import { TILE_FRAG } from '../src/renderer/shaders/tile.frag.js';
import { TILE_VERT } from '../src/renderer/shaders/tile.vert.js';

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
  it('ids are the linear/log/asinh/trilogy branch order in the shader', () => {
    expect(STRETCH_MODE_IDS).toEqual({ linear: 0, log: 1, asinh: 2, trilogy: 3 });
  });
  it('isStretchMode is a correct guard', () => {
    for (const m of STRETCH_MODES) expect(isStretchMode(m)).toBe(true);
    expect(isStretchMode('trilogy')).toBe(true);
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
    const trilogy3 = TILE_FRAG.indexOf('u_stretchMode == 3');
    const logBody = TILE_FRAG.indexOf('log(LOG_A * norm + 1.0)');
    const asinhBody = TILE_FRAG.indexOf('asinh(norm / ASINH_A)');
    const trilogyBody = TILE_FRAG.indexOf('log(k * norm + 1.0) / log(k + 1.0)');
    // branch 1 body is log (sits between `== 1` and `== 2`); branch 2 is asinh.
    expect(logBody).toBeGreaterThan(log1);
    expect(logBody).toBeLessThan(asinh2);
    expect(asinhBody).toBeGreaterThan(asinh2);
    // branch 3 is trilogy: the data-solved softening curve, after asinh.
    expect(trilogy3).toBeGreaterThan(asinh2);
    expect(trilogyBody).toBeGreaterThan(trilogy3);
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
    // D8: all-NaN -> opaque background (u_bg), AND each channel independently
    // falls back to 0.
    expect(TILE_FRAG).toContain('rn && gn && bn');
    expect(TILE_FRAG).toContain('rn ? 0.0 :');
    expect(TILE_FRAG).toContain('gn ? 0.0 :');
    expect(TILE_FRAG).toContain('bn ? 0.0 :');
  });

  it('pins the load-bearing no-data outputs (opaque background at FULL alpha, not u_opacity)', () => {
    // Without a headless WebGL2 we cannot execute the shader, so pin the exact
    // OUTPUTS — not just the predicates. No-data (all-NaN) must emit the OPAQUE
    // background `u_bg` at full alpha so it OCCLUDES the coarse fallback drawn
    // beneath it (otherwise a coarser level's nanmean-grown edge bleeds through
    // the finer NaN — the zoom-out edge flash). Two regressions to catch:
    //   1. reverting to a transparent pixel (vec4(...,0.0)) — reopens the bleed;
    //   2. emitting it at vec4(u_bg, u_opacity) — bleeds back mid-crossfade.
    expect(TILE_FRAG).toContain('uniform vec3 u_bg');
    expect(TILE_FRAG).not.toContain('vec4(0.0, 0.0, 0.0, 0.0)');
    const allNan = TILE_FRAG.indexOf('rn && gn && bn');
    expect(allNan).toBeGreaterThan(-1);
    // The all-NaN branch emits opaque background at FULL alpha, right after it.
    const bgOut = TILE_FRAG.indexOf('vec4(u_bg, 1.0)', allNan);
    expect(bgOut).toBeGreaterThan(allNan);
    // The composited (not-all-NaN) path writes RGB at the crossfade-in alpha
    // (u_opacity, == 1 once settled) — distinct from the no-data branch's full
    // alpha, so the occluding-no-data contract is preserved.
    const composite = TILE_FRAG.indexOf('vec4(rs, gs, bs, u_opacity)');
    expect(composite).toBeGreaterThan(bgOut);
    // Single-band no-data takes the same opaque-background path (a second u_bg out).
    expect(TILE_FRAG.indexOf('vec4(u_bg, 1.0)', composite)).toBeGreaterThan(composite);
  });

  it('targets GLSL ES 3.00 with highp (required for R32F range)', () => {
    expect(TILE_FRAG.startsWith('#version 300 es')).toBe(true);
    expect(TILE_FRAG).toContain('precision highp float');
  });
});

describe('RGB composite — per-channel stretch is independent, the curve is shared (D5/M4)', () => {
  // The shader composites scaleChannel(c, u_minRGB.c, u_maxRGB.c) per channel
  // under a single u_stretchMode. These behavioural tests model that contract
  // with the tested `scaleValue` (the GLSL `scaleChannel` mirrors it exactly).
  it('each channel maps the same value through its OWN [min,max]', () => {
    const v = 5;
    expect(scaleValue(v, 0, 10, 'linear')).toBeCloseTo(0.5, 12); // R
    expect(scaleValue(v, 0, 20, 'linear')).toBeCloseTo(0.25, 12); // G
    expect(scaleValue(v, -5, 5, 'linear')).toBeCloseTo(1, 12); // B (clamped at hi)
  });

  it('switching the SHARED mode lifts every channel identically (no per-channel mode)', () => {
    // Identical intervals + a shared mode ⟹ identical channel outputs; a
    // per-channel mode would let them diverge here. Guards against an accidental
    // ivec3 u_stretchModeRGB.
    const a = scaleValue(1, 0, 10, 'asinh');
    const b = scaleValue(1, 0, 10, 'asinh');
    const c = scaleValue(1, 0, 10, 'asinh');
    expect(a).toBe(b);
    expect(b).toBe(c);
    // ...and the shared asinh lifts faint signal above linear for every channel.
    expect(a).toBeGreaterThan(scaleValue(1, 0, 10, 'linear'));
  });
});

describe('trilogy — solved-softening log curve (faithful, color-preserving)', () => {
  it('trilogyCurve is the log shape with a free softening (log == trilogy at k=1000)', () => {
    for (const x of [0, 0.1, 0.3, 0.5, 0.9, 1]) {
      expect(trilogyCurve(x, LOG_SOFTENING)).toBeCloseTo(applyStretch(x, 'log'), 12);
    }
  });

  it('trilogyCurve fixes the endpoints for any positive k', () => {
    for (const k of [0.5, 10, 1000, 1e5]) {
      expect(trilogyCurve(0, k)).toBe(0);
      expect(trilogyCurve(1, k)).toBeCloseTo(1, 12);
    }
  });

  it('solveTrilogyK places the noise level at the requested luminance', () => {
    // The defining trilogy property: f(norm1) == noiselum at the solved k.
    for (const [norm1, noiselum] of [
      [0.01, 0.15],
      [0.05, 0.3],
      [0.001, 0.1],
      [0.2, 0.6],
    ] as const) {
      const k = solveTrilogyK(norm1, noiselum);
      expect(trilogyCurve(norm1, k)).toBeCloseTo(noiselum, 6);
    }
  });

  it('solveTrilogyK degenerates gracefully outside the reachable band', () => {
    // noiselum <= norm1 is unreachable upward -> linear (k=0): f(norm1)=norm1.
    const k0 = solveTrilogyK(0.3, 0.2);
    expect(k0).toBe(0);
    expect(trilogyCurve(0.3, k0)).toBeCloseTo(0.3, 12);
  });

  it('saturationValue maps satpercent to the matching bright-tail percentile', () => {
    const tail = { p99: 10, p99_9: 20, p99_99: 30, p99_999: 40 };
    expect(saturationValue(tail, 1)).toBeCloseTo(10, 12); // p99
    expect(saturationValue(tail, 0.1)).toBeCloseTo(20, 12); // p99.9
    expect(saturationValue(tail, 0.01)).toBeCloseTo(30, 12); // p99.99
    expect(saturationValue(tail, 0.001)).toBeCloseTo(40, 12); // p99.999
    // Interpolated in log10(satpercent): 0.0316 sits halfway between p99.9 & p99.99.
    expect(saturationValue(tail, Math.sqrt(0.1 * 0.01))).toBeCloseTo(25, 6);
    // Clamped beyond the anchors.
    expect(saturationValue(tail, 5)).toBeCloseTo(10, 12);
    expect(saturationValue(tail, 1e-6)).toBeCloseTo(40, 12);
  });

  const STATS: TrilogyStats = {
    mean: 100,
    sigma: 5,
    tail: { p99: 200, p99_9: 400, p99_99: 800, p99_999: 1600 },
  };

  it('trilogyLevels derives x0/x1/x2 from stats + knobs and pins the noise luminance', () => {
    const lv = trilogyLevels(STATS, DEFAULT_TRILOGY_PARAMS);
    expect(lv.x0).toBeCloseTo(100 - 2 * 5, 12); // mean - noisesig0*sigma
    expect(lv.x1).toBeCloseTo(100 + 1 * 5, 12); // mean + noisesig*sigma
    expect(lv.x2).toBeCloseTo(1600, 12); // satpercent 0.001 -> p99.999
    const norm1 = (lv.x1 - lv.x0) / (lv.x2 - lv.x0);
    expect(trilogyCurve(norm1, lv.k)).toBeCloseTo(DEFAULT_TRILOGY_PARAMS.noiselum, 6);
  });

  it('combineTrilogyLuminance keeps grey at the noise level mapping to noiselum', () => {
    const lv = trilogyLevels(STATS, DEFAULT_TRILOGY_PARAMS);
    const lum = combineTrilogyLuminance([lv, lv, lv], DEFAULT_TRILOGY_PARAMS.noiselum);
    // Three identical channels -> luminance saturation is the channel's (x2-x0).
    expect(lum.lsat).toBeCloseTo(lv.x2 - lv.x0, 9);
    // A grey pixel at the noise level: L = x1 - x0, normalized over lsat -> noiselum.
    const normL = (lv.x1 - lv.x0) / lum.lsat;
    expect(trilogyCurve(normL, lum.k)).toBeCloseTo(DEFAULT_TRILOGY_PARAMS.noiselum, 6);
  });
});

describe('TILE_FRAG — color-preserving trilogy RGB branch', () => {
  it('selects the coupled luminance path only for the trilogy mode in RGB', () => {
    // The RGB branch must special-case u_stretchMode == 3 (luminance rescale)
    // and leave modes 0-2 on the independent per-channel path.
    const rgb = TILE_FRAG.indexOf('u_mode == 1');
    const trilogyRgb = TILE_FRAG.indexOf('u_stretchMode == 3', rgb);
    expect(trilogyRgb).toBeGreaterThan(rgb);
  });

  it('bias-subtracts per channel, stretches luminance, and rescales by z/L', () => {
    expect(TILE_FRAG).toContain('max(r - u_minRGB.r, 0.0)');
    expect(TILE_FRAG).toContain('(rb + gb + bb) / 3.0');
    expect(TILE_FRAG).toContain('clamp(L / u_trilogyLsat, 0.0, 1.0)');
    expect(TILE_FRAG).toContain('applyStretch(norm, u_trilogyK)');
    expect(TILE_FRAG).toContain('L > 0.0 ? z / L : 0.0');
  });

  it('declares the trilogy uniforms', () => {
    for (const u of ['u_trilogyK', 'u_trilogyLsat']) expect(TILE_FRAG).toContain(u);
  });
});

describe('weighted multi-band trilogy — pure helpers (faithful composite)', () => {
  const STATS: TrilogyStats = {
    mean: 100,
    sigma: 5,
    tail: { p99: 400, p99_9: 700, p99_99: 1000, p99_999: 1600 },
  };

  it('hsvToRgb maps the primary hues exactly', () => {
    expect(hsvToRgb(0, 1, 1)).toEqual([1, 0, 0]); // red
    const g = hsvToRgb(120, 1, 1);
    expect(g[0]).toBeCloseTo(0, 12);
    expect(g[1]).toBeCloseTo(1, 12);
    expect(g[2]).toBeCloseTo(0, 12);
    const b = hsvToRgb(240, 1, 1);
    expect(b[0]).toBeCloseTo(0, 12);
    expect(b[1]).toBeCloseTo(0, 12);
    expect(b[2]).toBeCloseTo(1, 12);
  });

  it('rainbowWeights spreads bands blue→red and a single band is white', () => {
    expect(rainbowWeights(0)).toEqual([]);
    expect(rainbowWeights(1)).toEqual([[1, 1, 1]]);
    const two = rainbowWeights(2);
    expect(two[0][2]).toBeCloseTo(1, 12); // bluest first
    expect(two[1][0]).toBeCloseTo(1, 12); // reddest last
    const five = rainbowWeights(5);
    expect(five[0][2]).toBeCloseTo(1, 12); // blue
    expect(five[2][1]).toBeCloseTo(1, 12); // green midpoint (hue 120)
    expect(five[4][0]).toBeCloseTo(1, 12); // red
    // Every output channel gets some weight across the set (no dark channel).
    const sum = five.reduce((a, w) => [a[0] + w[0], a[1] + w[1], a[2] + w[2]], [0, 0, 0]);
    for (const c of sum) expect(c).toBeGreaterThan(0);
  });

  it('trilogyLevelsForBands is the per-band trilogyLevels, length preserved', () => {
    const a: TrilogyStats = { ...STATS, mean: 50 };
    const levels = trilogyLevelsForBands([STATS, a], DEFAULT_TRILOGY_PARAMS);
    expect(levels).toHaveLength(2);
    expect(levels[0]).toEqual(trilogyLevels(STATS, DEFAULT_TRILOGY_PARAMS));
    expect(levels[1]).toEqual(trilogyLevels(a, DEFAULT_TRILOGY_PARAMS));
  });

  it('weightedTrilogyPixel is the per-band stretch then weighted average', () => {
    const lv = trilogyLevels(STATS, DEFAULT_TRILOGY_PARAMS);
    const s = scaleValue(300, lv.x0, lv.x2, 'trilogy', lv.k);
    // Two bands: pure red and pure blue, same value -> R == B == s, G == 0 (den 0).
    const weights: BandWeight[] = [
      [1, 0, 0],
      [0, 0, 1],
    ];
    const out = weightedTrilogyPixel([300, 300], [lv, lv], weights);
    expect(out[0]).toBeCloseTo(s, 12);
    expect(out[1]).toBe(0); // green weight-sum is 0
    expect(out[2]).toBeCloseTo(s, 12);
  });

  it('a NaN band contributes 0 but still counts in the weight denominator', () => {
    const lv = trilogyLevels(STATS, DEFAULT_TRILOGY_PARAMS);
    const s = scaleValue(300, lv.x0, lv.x2, 'trilogy', lv.k);
    // Both bands red-weighted; band 1 is NaN -> R = (1*s + 1*0) / (1 + 1).
    const out = weightedTrilogyPixel(
      [300, NaN],
      [lv, lv],
      [
        [1, 0, 0],
        [1, 0, 0],
      ],
    );
    expect(out[0]).toBeCloseTo(s / 2, 12);
    expect(out[1]).toBe(0);
    expect(out[2]).toBe(0);
  });

  it('clamps each output channel to [0,1]', () => {
    const lv = trilogyLevels(STATS, DEFAULT_TRILOGY_PARAMS);
    // A weight > 1 with sum == weight gives num/den = s (<=1); use two unit weights
    // and a saturating value to confirm the clamp path holds at the ceiling.
    const out = weightedTrilogyPixel([1e9], [lv], [[2, 0, 0]]);
    expect(out[0]).toBeLessThanOrEqual(1);
    expect(out[0]).toBeGreaterThanOrEqual(0);
  });
});

describe('TILE_FRAG — weighted multi-band trilogy branch (u_mode == 2)', () => {
  it('inlines MAX_BANDS from stretch.ts so the GLSL array size cannot drift', () => {
    expect(TILE_FRAG).toContain(`const int MAX_BANDS = ${MAX_BANDS}`);
    expect(TILE_FRAG).toContain('uniform sampler2D u_band[MAX_BANDS]');
  });

  it('declares MAX_BANDS before it is used as a uniform array size (GLSL needs decl-before-use)', () => {
    // The browser is the only thing that compiles this shader; Node never does.
    // GLSL ES requires the array-length identifier to exist before the uniform
    // declarations reference it, or every `[MAX_BANDS]` is an undeclared-identifier
    // compile error. Guard the ordering statically so the regression can't recur.
    const decl = TILE_FRAG.indexOf('const int MAX_BANDS =');
    const firstUse = TILE_FRAG.indexOf('[MAX_BANDS]');
    expect(decl).toBeGreaterThan(0);
    expect(firstUse).toBeGreaterThan(0);
    expect(decl).toBeLessThan(firstUse);
  });

  it('accumulates per-band weighted, trilogy-stretched contributions', () => {
    const mb = TILE_FRAG.indexOf('u_mode == 2');
    expect(mb).toBeGreaterThan(0);
    expect(TILE_FRAG).toContain('texture(u_band[i], v_uv).r');
    expect(TILE_FRAG).toContain('scaleChannel(v, u_bx0[i], u_bx2[i], u_bk[i])');
    expect(TILE_FRAG).toContain('num += u_weight[i] * s');
    // Normalized by the host-precomputed Σ weights, with a per-channel zero guard.
    expect(TILE_FRAG).toContain('u_weightSum.r > 0.0 ? num.r / u_weightSum.r : 0.0');
  });

  it('emits the background only when ALL participating bands are NaN', () => {
    expect(TILE_FRAG).toContain('nanCount == u_nBands');
    const guard = TILE_FRAG.indexOf('nanCount == u_nBands');
    expect(TILE_FRAG.indexOf('vec4(u_bg, 1.0)', guard)).toBeGreaterThan(guard);
  });
});

describe('tile shaders — the single-UV constraint behind common-level-hold (M4)', () => {
  it('the vertex shader exposes exactly ONE shared texcoord (u_uv -> v_uv)', () => {
    // One u_uv/v_uv ⟹ all three RGB samplers read the SAME source level + sub-rect
    // in a draw call, which is precisely why the RGB draw must composite from a
    // level common to all three bands (commonResidentLevel).
    expect(TILE_VERT.match(/uniform vec4 u_uv/g)?.length).toBe(1);
    expect(TILE_VERT.match(/out vec2 v_uv/g)?.length).toBe(1);
  });

  it('the RGB fragment path samples all three bands at that one v_uv with per-channel intervals', () => {
    expect(TILE_FRAG).toContain('texture(u_tile, v_uv).r');
    expect(TILE_FRAG).toContain('texture(u_tileG, v_uv).r');
    expect(TILE_FRAG).toContain('texture(u_tileB, v_uv).r');
    expect(TILE_FRAG).toContain('u_minRGB.r');
    expect(TILE_FRAG).toContain('u_minRGB.g');
    expect(TILE_FRAG).toContain('u_minRGB.b');
    // A single shared transfer curve — no per-channel mode uniform.
    expect(TILE_FRAG).not.toContain('u_stretchModeRGB');
  });
});
