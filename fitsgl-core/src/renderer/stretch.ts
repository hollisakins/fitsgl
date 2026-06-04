/**
 * Non-linear display stretches (decision D5).
 *
 * The viewer normalizes a raw pixel value to [0,1] with the linear min/max
 * interval, then applies one of these transfer functions to that normalized
 * scalar before mapping it to grey or a colormap. The raw float data in the
 * textures is never modified — switching stretch only changes this curve.
 *
 * The two non-linear curves match astropy.visualization with FIXED softening
 * (D5): `LogStretch(a=1000)` and `AsinhStretch(a=0.1)`. Both map [0,1] -> [0,1]
 * with `f(0)=0`, `f(1)=1`, so clamping the *input* to [0,1] is sufficient to
 * keep the output in range.
 *
 * This module is the single source of truth for the softening constants and the
 * mode<->id mapping: `tile.frag.ts` inlines the same constants into GLSL and the
 * viewer sets `u_stretchMode` from `STRETCH_MODE_IDS`, so the tested pure
 * functions here and the shader cannot drift. No GL or DOM here — it unit-tests
 * under Node against astropy-generated golden values (`stretch.test.ts`).
 */

/**
 * Selectable transfer functions. `linear` is the identity (the existing path).
 * `trilogy` is the `log` curve with a *data-solved* softening `K` instead of the
 * fixed `LOG_SOFTENING`: the level-determination math (`trilogyLevels`) picks `K`
 * so the noise sits at a chosen output luminance. See `trilogyLevels` below.
 */
export type StretchMode = 'linear' | 'log' | 'asinh' | 'trilogy';

/** All stretch modes, in UI/declaration order. */
export const STRETCH_MODES: readonly StretchMode[] = ['linear', 'log', 'asinh', 'trilogy'];

/**
 * Integer ids handed to the shader's `u_stretchMode` uniform. Kept in lockstep
 * with the GLSL branch order in `tile.frag.ts`.
 */
export const STRETCH_MODE_IDS: Record<StretchMode, number> = {
  linear: 0,
  log: 1,
  asinh: 2,
  trilogy: 3,
};

/** Fixed `log` softening — astropy `LogStretch` default. */
export const LOG_SOFTENING = 1000;
/** Fixed `asinh` softening — astropy `AsinhStretch` default. */
export const ASINH_SOFTENING = 0.1;
/**
 * Default trilogy softening handed to the shader when a curve is requested
 * before levels are solved. Matching `LOG_SOFTENING` keeps `f(0)=0, f(1)=1` and
 * makes an un-fit trilogy curve look like the plain `log` stretch.
 */
export const DEFAULT_TRILOGY_K = LOG_SOFTENING;

export function isStretchMode(value: string): value is StretchMode {
  return value === 'linear' || value === 'log' || value === 'asinh' || value === 'trilogy';
}

/**
 * The trilogy log curve on an already-normalized [0,1] value: identical in form
 * to `log` but with a free softening `k` (`log` is the special case `k = 1000`).
 * `f(0)=0`, `f(1)=1` for any `k > 0`. Mirrors the GLSL `u_stretchMode == 3` body.
 */
export function trilogyCurve(norm: number, k: number): number {
  if (!(k > 0)) return norm; // the k -> 0 limit is the linear identity (avoids 0/0)
  return Math.log(k * norm + 1) / Math.log(k + 1);
}

/**
 * Apply a stretch transfer function to an already-normalized value. `norm` is
 * assumed to be in [0,1] (the caller clamps); the result is in [0,1]. Mirrors
 * the GLSL `applyStretch` exactly. `trilogyK` is consulted only by the `trilogy`
 * mode (and defaults to the plain-`log` softening so the curve is well-formed).
 */
export function applyStretch(norm: number, mode: StretchMode, trilogyK = DEFAULT_TRILOGY_K): number {
  switch (mode) {
    case 'log':
      return Math.log(LOG_SOFTENING * norm + 1) / Math.log(LOG_SOFTENING + 1);
    case 'asinh':
      return Math.asinh(norm / ASINH_SOFTENING) / Math.asinh(1 / ASINH_SOFTENING);
    case 'trilogy':
      return trilogyCurve(norm, trilogyK);
    case 'linear':
      return norm;
  }
}

/**
 * Full single-channel transfer: linear-normalize `v` over [lo, hi], clamp to
 * [0,1], then apply the stretch. Mirrors the GLSL `scaleChannel`. Callers are
 * expected to pass `hi > lo`; a degenerate range divides by <= 0 and yields a
 * clamped 0/1 (or NaN exactly at `v == lo == hi`), matching the shader.
 */
export function scaleValue(
  v: number,
  lo: number,
  hi: number,
  mode: StretchMode,
  trilogyK = DEFAULT_TRILOGY_K,
): number {
  const norm = Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
  return applyStretch(norm, mode, trilogyK);
}

// ---- trilogy level determination (decision: faithful, color-preserving) -----

/**
 * Per-band global statistics the build precomputes (on the native z=0 level,
 * subsampled) so trilogy gets stable, viewport-independent levels on the first
 * paint. `mean`/`sigma` are the robust sky level + MAD-scaled noise; `tail`
 * carries the bright-tail percentiles (the saturation point lives there, beyond
 * the 99.9th percentile the display histogram is clipped to). Mirrors the
 * `FitsglBandStats` wire shape and the Python `band_trilogy_stats` producer.
 */
export interface TrilogyStats {
  mean: number;
  sigma: number;
  tail: { p99: number; p99_9: number; p99_99: number; p99_999: number };
}

/** User-tunable trilogy knobs (Dan Coe's trilogy defaults). */
export interface TrilogyParams {
  /** Output luminance the noise level (`x1`) maps to. */
  noiselum: number;
  /** Percent of pixels allowed to saturate; `x2` is the `(100 - satpercent)` percentile. */
  satpercent: number;
  /** `x1 = mean + noisesig * sigma` — the noise level lifted to `noiselum`. */
  noisesig: number;
  /** `x0 = mean - noisesig0 * sigma` — the black point below the sky. */
  noisesig0: number;
}

export const DEFAULT_TRILOGY_PARAMS: TrilogyParams = {
  noiselum: 0.15,
  satpercent: 0.001,
  noisesig: 1,
  noisesig0: 2,
};

/** The three data levels + solved softening for one channel. */
export interface TrilogyLevels {
  /** Black point (output 0). */
  x0: number;
  /** Noise level (output `noiselum`). */
  x1: number;
  /** Saturation point (output 1). */
  x2: number;
  /** Softening solved so `f(x1) == noiselum`. */
  k: number;
}

/**
 * Solve `log(K*norm1 + 1) / log(K + 1) = noiselum` for `K > 0`. `g(K)` rises
 * monotonically from `norm1` (as `K -> 0`) to `1` (as `K -> inf`), so a unique
 * root exists when `norm1 < noiselum < 1`. Outside that the target is
 * unreachable by the log family: `noiselum <= norm1` degenerates to linear
 * (`K -> 0`), `noiselum >= 1` saturates (a large finite `K`). Bisection on a
 * doubling bracket — pure, no GL/IO, unit-tested against a reference root.
 */
export function solveTrilogyK(norm1: number, noiselum: number, iterations = 64): number {
  if (!(norm1 > 0) || !(norm1 < 1)) return DEFAULT_TRILOGY_K;
  if (noiselum <= norm1) return 0; // faint level already at/above target -> linear
  if (noiselum >= 1) return 1e30; // unreachable -> effectively saturated
  const g = (k: number): number => Math.log(k * norm1 + 1) / Math.log(k + 1);
  let lo = 0;
  let hi = 1;
  while (g(hi) < noiselum) {
    hi *= 2;
    if (hi > 1e30) return hi;
  }
  for (let i = 0; i < iterations; i++) {
    const mid = 0.5 * (lo + hi);
    if (g(mid) < noiselum) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/**
 * The saturation level `x2` for a given `satpercent`, interpolated from the
 * precomputed bright-tail percentiles. `satpercent` is the percent of pixels
 * allowed to clip, so it maps to the `(100 - satpercent)` percentile: 1 -> p99,
 * 0.1 -> p99.9, 0.01 -> p99.99, 0.001 -> p99.999. Interpolated linearly in
 * `log10(satpercent)` between those anchors and clamped to the stored range.
 */
export function saturationValue(tail: TrilogyStats['tail'], satpercent: number): number {
  const anchors: Array<[number, number]> = [
    [1, tail.p99],
    [0.1, tail.p99_9],
    [0.01, tail.p99_99],
    [0.001, tail.p99_999],
  ];
  const sp = Math.min(1, Math.max(0.001, satpercent));
  const x = Math.log10(sp);
  for (let i = 0; i < anchors.length - 1; i++) {
    const [pHi, vHi] = anchors[i];
    const [pLo, vLo] = anchors[i + 1];
    const xHi = Math.log10(pHi);
    const xLo = Math.log10(pLo);
    if (x <= xHi && x >= xLo) {
      const t = (x - xLo) / (xHi - xLo);
      return vLo + t * (vHi - vLo);
    }
  }
  // Outside [0.001, 1] the clamp above pins sp to an endpoint anchor.
  return sp >= 1 ? tail.p99 : tail.p99_999;
}

/**
 * Derive a single channel's trilogy levels from its precomputed global stats and
 * the user knobs, then solve the softening. `x0`/`x2` drive the black/white
 * points; `x1` (the noise level) is mapped to `noiselum` via the solved `k`.
 * Pure arithmetic — the host re-runs it instantly when a knob moves, no rescan.
 */
export function trilogyLevels(stats: TrilogyStats, params: TrilogyParams): TrilogyLevels {
  const x0 = stats.mean - params.noisesig0 * stats.sigma;
  const x1 = stats.mean + params.noisesig * stats.sigma;
  let x2 = saturationValue(stats.tail, params.satpercent);
  if (!(x2 > x0)) x2 = x0 + Math.max(stats.sigma, 1e-30);
  const norm1 = Math.min(0.999, Math.max(0, (x1 - x0) / (x2 - x0)));
  return { x0, x1, x2, k: solveTrilogyK(norm1, params.noiselum) };
}

/** The shared luminance stretch a color-preserving RGB composite samples. */
export interface TrilogyLuminance {
  /** Bias-subtracted luminance that maps to output 1. */
  lsat: number;
  /** Softening solved so the combined noise luminance maps to `noiselum`. */
  k: number;
}

/**
 * Combine three channels' levels into one luminance stretch for the
 * color-preserving composite (decision: shared luminance). Channels are
 * bias-subtracted by their own `x0`, so `L = mean(rb, gb, bb)`; its saturation
 * is the mean of the per-channel `(x2 - x0)` and its noise level the mean of the
 * per-channel `(x1 - x0)`. Solving `k` from that ratio keeps grey at the noise
 * level mapping to `noiselum`, exactly as a single channel would. Analytic — no
 * per-triple pixel scan, so any R/G/B assignment is O(1).
 */
export function combineTrilogyLuminance(
  levels: readonly [TrilogyLevels, TrilogyLevels, TrilogyLevels],
  noiselum: number,
): TrilogyLuminance {
  let lsat = 0;
  let l1 = 0;
  for (const lv of levels) {
    lsat += lv.x2 - lv.x0;
    l1 += lv.x1 - lv.x0;
  }
  lsat /= 3;
  l1 /= 3;
  if (!(lsat > 0)) lsat = Math.max(l1, 1e-30);
  const norm1 = Math.min(0.999, Math.max(0, l1 / lsat));
  return { lsat, k: solveTrilogyK(norm1, noiselum) };
}
