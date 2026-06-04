/**
 * Built-in single-band colormaps (decision D6).
 *
 * For single-band view the post-stretch scalar in [0,1] is mapped through a 1-D
 * colormap LUT. This module bundles matplotlib's perceptually-uniform palettes
 * (plus plain grayscale) as compact base64 RGB tables and exposes them as the
 * RGBA bytes the renderer uploads as a `COLORMAP_SIZE × 1` LUT texture.
 *
 * The bundled byte tables are GENERATED from matplotlib — see
 * `test/fixtures/generate_colormap_fixtures.py`, which writes both
 * `colormap-data.ts` (shipped here) and the golden JSON the test checks against,
 * so the shipped palette cannot drift from matplotlib.
 *
 * The public API also accepts a raw LUT (`Uint8Array` of RGB triples), so a host
 * can supply a palette that isn't bundled (free future-proofing for CAMPFIRE).
 * No GL or DOM here — `colormaps.test.ts` exercises it under Node.
 */

import { COLORMAP_RGB_B64, COLORMAP_SIZE } from './colormap-data.js';

export { COLORMAP_SIZE };

/** Name of a bundled palette. Derived from the generated data so they stay in sync. */
export type ColormapName = keyof typeof COLORMAP_RGB_B64;

/** Bundled palette names, in declaration order (gray first, the default-equivalent). */
export const COLORMAP_NAMES = Object.keys(COLORMAP_RGB_B64) as ColormapName[];

/**
 * A raw colormap: N×3 row-major RGB bytes (`length` a multiple of 3). Accepted
 * by `FitsViewer.setColormap` so hosts can pass a palette we don't bundle.
 */
export type ColormapLUT = Uint8Array;

export function isColormapName(value: string): value is ColormapName {
  return Object.prototype.hasOwnProperty.call(COLORMAP_RGB_B64, value);
}

/** Decode base64 to bytes. Works under both browser and Node (atob is global in both). */
function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Decode lazily and cache: a palette is only materialized when first requested.
const rgbCache = new Map<ColormapName, Uint8Array>();

/**
 * Decoded N×3 row-major RGB bytes for a bundled palette. The returned array is
 * the shared cached buffer — treat it as read-only; copy before mutating, or the
 * bundled palette is corrupted for every later caller.
 */
export function colormapRGB(name: ColormapName): Uint8Array {
  let rgb = rgbCache.get(name);
  if (rgb === undefined) {
    rgb = decodeBase64(COLORMAP_RGB_B64[name]);
    rgbCache.set(name, rgb);
  }
  return rgb;
}

/**
 * Expand N×3 RGB bytes to N×4 RGBA (opaque). Throws if `rgb.length` is not a
 * multiple of 3 — that guards a malformed raw LUT before it reaches the GPU.
 */
export function rgbToRGBA(rgb: Uint8Array): Uint8Array {
  if (rgb.length === 0 || rgb.length % 3 !== 0) {
    throw new Error(
      `colormaps: LUT length ${rgb.length} is not a positive multiple of 3 (RGB triples)`,
    );
  }
  const n = rgb.length / 3;
  const rgba = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    rgba[i * 4 + 0] = rgb[i * 3 + 0]!;
    rgba[i * 4 + 1] = rgb[i * 3 + 1]!;
    rgba[i * 4 + 2] = rgb[i * 3 + 2]!;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

/**
 * Resolve a colormap spec to the `{ rgba, size }` a LUT texture upload needs.
 * `spec` is a bundled name or a raw RGB `Uint8Array`.
 */
export function resolveColormap(spec: ColormapName | ColormapLUT): {
  rgba: Uint8Array;
  size: number;
} {
  const rgb = typeof spec === 'string' ? colormapRGB(spec) : spec;
  const rgba = rgbToRGBA(rgb);
  return { rgba, size: rgba.length / 4 };
}
