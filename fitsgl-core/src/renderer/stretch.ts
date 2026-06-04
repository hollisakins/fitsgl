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

/** Selectable transfer functions. `linear` is the identity (the existing path). */
export type StretchMode = 'linear' | 'log' | 'asinh';

/** All stretch modes, in UI/declaration order. */
export const STRETCH_MODES: readonly StretchMode[] = ['linear', 'log', 'asinh'];

/**
 * Integer ids handed to the shader's `u_stretchMode` uniform. Kept in lockstep
 * with the GLSL branch order in `tile.frag.ts`.
 */
export const STRETCH_MODE_IDS: Record<StretchMode, number> = {
  linear: 0,
  log: 1,
  asinh: 2,
};

/** Fixed `log` softening — astropy `LogStretch` default. */
export const LOG_SOFTENING = 1000;
/** Fixed `asinh` softening — astropy `AsinhStretch` default. */
export const ASINH_SOFTENING = 0.1;

export function isStretchMode(value: string): value is StretchMode {
  return value === 'linear' || value === 'log' || value === 'asinh';
}

/**
 * Apply a stretch transfer function to an already-normalized value. `norm` is
 * assumed to be in [0,1] (the caller clamps); the result is in [0,1]. Mirrors
 * the GLSL `applyStretch` exactly.
 */
export function applyStretch(norm: number, mode: StretchMode): number {
  switch (mode) {
    case 'log':
      return Math.log(LOG_SOFTENING * norm + 1) / Math.log(LOG_SOFTENING + 1);
    case 'asinh':
      return Math.asinh(norm / ASINH_SOFTENING) / Math.asinh(1 / ASINH_SOFTENING);
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
export function scaleValue(v: number, lo: number, hi: number, mode: StretchMode): number {
  const norm = Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
  return applyStretch(norm, mode);
}
