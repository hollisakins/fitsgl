/**
 * Tile fragment shader (GLSL ES 3.00) — the single "mega-shader" (decision D5).
 *
 * One program with uniform branches covers every v1.0 display mode so the shader
 * is not rewritten per feature:
 *   - `u_mode`        0 = single-band, 1 = RGB composite (the M4 slot), 2 = weighted
 *                     multi-band trilogy composite (N bands, each with an (R,G,B)
 *                     contribution weight — Dan Coe's faithful trilogy).
 *   - `u_stretchMode` 0 = linear, 1 = log, 2 = asinh, 3 = trilogy — see `stretch.ts`.
 *   - `u_useColormap` single-band only: 0 = grayscale, 1 = sample `u_colormap`.
 *
 * The raw float values live untouched in the R32F textures; this shader does the
 * min/max normalization, the (optional non-linear) stretch, and the grey/LUT
 * mapping on the fly, so changing stretch or colormap never refetches data.
 * NaN pixels (blank/edge padding, preserved bit-exact through the decode path)
 * are emitted as the OPAQUE background colour `u_bg`, not transparent. The
 * settled look is identical (the canvas clears to that same colour), but an
 * opaque no-data pixel OCCLUDES whatever coarse fallback tile was painted beneath
 * it this frame instead of revealing it — so a coarser level's nanmean-grown edge
 * can no longer bleed through the finer level's NaN holes (the zoom-out edge
 * flash). Full alpha is deliberate: it must occlude even mid-crossfade, when the
 * tile on top is otherwise drawn at `u_opacity < 1`. In RGB mode a NaN contributes
 * 0 to its channel and the pixel is background only when all three are NaN (D8).
 *
 * `highp float` is required: R32F samples span the full float range and `mediump`
 * would collapse large pixel values. The asinh/log softening constants are
 * inlined from `stretch.ts` (the same source the tested pure functions use), so
 * the GLSL curve and the TS reference cannot drift.
 */

import { ASINH_SOFTENING, LOG_SOFTENING, MAX_BANDS } from '../stretch.js';

/** Format a JS number as a GLSL `float` literal (always with a decimal point). */
function glslFloat(n: number): string {
  return Number.isInteger(n) ? `${n}.0` : `${n}`;
}

/**
 * Emit a literal-indexed dispatch over the `u_band[]` sampler array. GLSL ES
 * 3.00 (spec §4.1.7) requires a sampler-array index to be a *constant integral
 * expression* — a loop induction variable is not one, so `u_band[i]` is invalid
 * even though some drivers unroll the loop and tolerate it. Comparing `idx`
 * against each literal index keeps every `u_band[N]` a compile-time constant.
 */
function bandSamplerDispatch(): string {
  let body = '';
  for (let i = 0; i < MAX_BANDS; i++) {
    body += `  if (idx == ${i}) return texture(u_band[${i}], v_uv).r;\n`;
  }
  return body;
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

uniform int u_mode;         // 0 = single-band, 1 = RGB composite, 2 = weighted multi-band
uniform int u_stretchMode;  // 0 = linear, 1 = log, 2 = asinh, 3 = trilogy
uniform int u_useColormap;  // single-band: 0 = grayscale, 1 = colormap LUT

uniform float u_min;        // single-band display interval
uniform float u_max;
uniform vec3 u_minRGB;      // RGB mode per-channel interval (M4 slot); trilogy: black points x0
uniform vec3 u_maxRGB;
uniform float u_opacity;    // crossfade-in ramp (1 = fully settled); scales alpha
uniform float u_trilogyK;   // trilogy softening (mode 3); solved on the host from noiselum
uniform float u_trilogyLsat;// trilogy RGB: bias-subtracted luminance mapping to 1
uniform vec3 u_bg;          // opaque background colour; NaN/no-data pixels emit this

// Declared before the uniform block below: GLSL ES requires the array-size
// identifier to exist before it is used as a uniform array length.
const int MAX_BANDS = ${MAX_BANDS};

// Weighted multi-band trilogy (u_mode == 2): one entry per participating band.
uniform sampler2D u_band[MAX_BANDS]; // band textures, bound by the viewer's unit map
uniform vec3 u_weight[MAX_BANDS];    // per-band (R,G,B) contribution weight
uniform float u_bx0[MAX_BANDS];      // per-band trilogy black point (x0)
uniform float u_bx2[MAX_BANDS];      // per-band trilogy white point (x2)
uniform float u_bk[MAX_BANDS];       // per-band trilogy softening (k)
uniform int u_nBands;                // number of participating bands (<= MAX_BANDS)
uniform vec3 u_weightSum;            // host-precomputed Σ weights per channel

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

// Sample band texture \`idx\` from the sampler array via literal-constant indices
// (see bandSamplerDispatch / GLSL ES 3.00 §4.1.7): a sampler-array subscript must
// be a constant integral expression, which a loop variable is not.
float sampleBand(int idx) {
${bandSamplerDispatch()}  return 0.0;
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
      // No data in any channel: opaque background, so it occludes the fallback
      // beneath rather than letting a coarse ancestor bleed through (full alpha,
      // not u_opacity, so it holds even mid-crossfade).
      outColor = vec4(u_bg, 1.0);
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

  if (u_mode == 2) {
    // Weighted multi-band trilogy (Dan Coe's faithful composite). Each band is
    // trilogy-stretched by its OWN levels to s_i in [0,1] (u_stretchMode == 3 so
    // scaleChannel takes the trilogy arm with the band's own k); the channels are
    // weighted averages num/u_weightSum, with the Σ weights precomputed on the
    // host so a zero-weight channel is exactly 0. A NaN band contributes 0 to
    // every channel; the pixel is opaque background only when ALL participating
    // bands are NaN (generalizes the D8 all-three-NaN rule). The loop bound is the
    // fixed MAX_BANDS with an early break; the sampler array is indexed only by
    // literal constants inside sampleBand() (GLSL ES 3.00 §4.1.7 forbids indexing
    // a sampler array with the loop induction variable).
    vec3 num = vec3(0.0);
    int nanCount = 0;
    for (int i = 0; i < MAX_BANDS; i++) {
      if (i >= u_nBands) break;
      float v = sampleBand(i);
      if (isnan(v)) { nanCount++; continue; }
      float s = scaleChannel(v, u_bx0[i], u_bx2[i], u_bk[i]);
      num += u_weight[i] * s;
    }
    if (nanCount == u_nBands) {
      outColor = vec4(u_bg, 1.0);
      return;
    }
    vec3 rgb = vec3(
      u_weightSum.r > 0.0 ? num.r / u_weightSum.r : 0.0,
      u_weightSum.g > 0.0 ? num.g / u_weightSum.g : 0.0,
      u_weightSum.b > 0.0 ? num.b / u_weightSum.b : 0.0);
    outColor = vec4(clamp(rgb, 0.0, 1.0), u_opacity);
    return;
  }

  // Single-band. NaN (blank/edge padding) is opaque background — occludes the
  // fallback beneath instead of revealing it (full alpha, not u_opacity).
  float v = texture(u_tile, v_uv).r;
  if (isnan(v)) {
    outColor = vec4(u_bg, 1.0);
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
