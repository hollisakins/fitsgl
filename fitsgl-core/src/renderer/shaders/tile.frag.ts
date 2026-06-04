/**
 * Tile fragment shader (GLSL ES 3.00) — the single "mega-shader" (decision D5).
 *
 * One program with uniform branches covers every v1.0 display mode so the shader
 * is not rewritten per feature:
 *   - `u_mode`        0 = single-band, 1 = RGB composite (the M4 slot, built now).
 *   - `u_stretchMode` 0 = linear, 1 = log, 2 = asinh — see `stretch.ts`.
 *   - `u_useColormap` single-band only: 0 = grayscale, 1 = sample `u_colormap`.
 *
 * The raw float values live untouched in the R32F textures; this shader does the
 * min/max normalization, the (optional non-linear) stretch, and the grey/LUT
 * mapping on the fly, so changing stretch or colormap never refetches data.
 * NaN pixels (blank/edge padding, preserved bit-exact through the decode path)
 * are emitted transparent. In RGB mode a NaN contributes 0 to its channel and a
 * pixel is transparent only when all three channels are NaN (decision D8).
 *
 * `highp float` is required: R32F samples span the full float range and `mediump`
 * would collapse large pixel values. The asinh/log softening constants are
 * inlined from `stretch.ts` (the same source the tested pure functions use), so
 * the GLSL curve and the TS reference cannot drift.
 */

import { ASINH_SOFTENING, LOG_SOFTENING } from '../stretch.js';

/** Format a JS number as a GLSL `float` literal (always with a decimal point). */
function glslFloat(n: number): string {
  return Number.isInteger(n) ? `${n}.0` : `${n}`;
}

export const TILE_FRAG = `#version 300 es
precision highp float;

// Single-band tile, or the R channel in RGB composite mode.
uniform sampler2D u_tile;
// G/B channels for RGB composite mode (the M4 slot; viewer wires these later).
uniform sampler2D u_tileG;
uniform sampler2D u_tileB;
// 1-D palette sampled by the single-band colormap path.
uniform sampler2D u_colormap;

uniform int u_mode;         // 0 = single-band, 1 = RGB composite
uniform int u_stretchMode;  // 0 = linear, 1 = log, 2 = asinh, 3 = trilogy
uniform int u_useColormap;  // single-band: 0 = grayscale, 1 = colormap LUT

uniform float u_min;        // single-band display interval
uniform float u_max;
uniform vec3 u_minRGB;      // RGB mode per-channel interval (M4 slot); trilogy: black points x0
uniform vec3 u_maxRGB;
uniform float u_opacity;    // crossfade-in ramp (1 = fully settled); scales alpha
uniform float u_trilogyK;   // trilogy softening (mode 3); solved on the host from noiselum
uniform float u_trilogyLsat;// trilogy RGB: bias-subtracted luminance mapping to 1

const float LOG_A = ${glslFloat(LOG_SOFTENING)};
const float ASINH_A = ${glslFloat(ASINH_SOFTENING)};

in vec2 v_uv;
out vec4 outColor;

// Stretch transfer on an already-normalized [0,1] value. Mirrors stretch.ts.
// k is consulted only by trilogy (mode 3); the other modes ignore it.
float applyStretch(float norm, float k) {
  if (u_stretchMode == 1) {
    return log(LOG_A * norm + 1.0) / log(LOG_A + 1.0);
  } else if (u_stretchMode == 2) {
    return asinh(norm / ASINH_A) / asinh(1.0 / ASINH_A);
  } else if (u_stretchMode == 3) {
    if (!(k > 0.0)) return norm; // k -> 0 (and NaN) limit is linear; mirrors stretch.ts !(k > 0)
    return log(k * norm + 1.0) / log(k + 1.0);
  }
  return norm; // linear
}

// Normalize over [lo, hi], clamp, then stretch. Mirrors stretch.ts scaleValue.
float scaleChannel(float v, float lo, float hi, float k) {
  float norm = clamp((v - lo) / (hi - lo), 0.0, 1.0);
  return applyStretch(norm, k);
}

void main() {
  if (u_mode == 1) {
    // RGB composite (M4). Per-channel NaN -> 0; transparent only if all NaN (D8).
    float r = texture(u_tile, v_uv).r;
    float g = texture(u_tileG, v_uv).r;
    float b = texture(u_tileB, v_uv).r;
    bool rn = isnan(r);
    bool gn = isnan(g);
    bool bn = isnan(b);
    if (rn && gn && bn) {
      outColor = vec4(0.0, 0.0, 0.0, 0.0);
      return;
    }
    if (u_stretchMode == 3) {
      // Color-preserving trilogy: bias-subtract each channel by its own black
      // point (u_minRGB = x0), stretch the shared luminance, then rescale the
      // triple by z/L so hue/ratios are preserved (decision: shared luminance).
      float rb = rn ? 0.0 : max(r - u_minRGB.r, 0.0);
      float gb = gn ? 0.0 : max(g - u_minRGB.g, 0.0);
      float bb = bn ? 0.0 : max(b - u_minRGB.b, 0.0);
      float L = (rb + gb + bb) / 3.0;
      float norm = clamp(L / u_trilogyLsat, 0.0, 1.0);
      float z = applyStretch(norm, u_trilogyK);
      float scale = L > 0.0 ? z / L : 0.0;
      outColor = vec4(
        clamp(rb * scale, 0.0, 1.0),
        clamp(gb * scale, 0.0, 1.0),
        clamp(bb * scale, 0.0, 1.0),
        u_opacity);
      return;
    }
    float rs = rn ? 0.0 : scaleChannel(r, u_minRGB.r, u_maxRGB.r, u_trilogyK);
    float gs = gn ? 0.0 : scaleChannel(g, u_minRGB.g, u_maxRGB.g, u_trilogyK);
    float bs = bn ? 0.0 : scaleChannel(b, u_minRGB.b, u_maxRGB.b, u_trilogyK);
    outColor = vec4(rs, gs, bs, u_opacity);
    return;
  }

  // Single-band. NaN (blank/edge padding) is fully transparent.
  float v = texture(u_tile, v_uv).r;
  if (isnan(v)) {
    outColor = vec4(0.0, 0.0, 0.0, 0.0);
    return;
  }
  float s = scaleChannel(v, u_min, u_max, u_trilogyK);
  if (u_useColormap == 1) {
    // Sample the LUT along its width at the row centre; CLAMP_TO_EDGE pins the
    // [0,1] endpoints to the first/last texel.
    outColor = vec4(texture(u_colormap, vec2(s, 0.5)).rgb, u_opacity);
  } else {
    outColor = vec4(s, s, s, u_opacity);
  }
}
`;
