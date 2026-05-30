/**
 * Tile fragment shader (GLSL ES 3.00).
 *
 * Samples the single-channel R32F tile texture and applies an on-the-fly linear
 * stretch: `s = clamp((v - u_min) / (u_max - u_min), 0, 1)`, written to RGB as
 * grey. NaN pixels (blank/edge padding, preserved bit-exact through Phase 2b's
 * GZIP_2 path) are emitted fully transparent so the canvas clear colour shows
 * through rather than a stretched garbage value.
 *
 * `highp float` is required: R32F samples span the full float range and `mediump`
 * would collapse large pixel values. Linear stretch only; asinh/log are deferred.
 */
export const TILE_FRAG = `#version 300 es
precision highp float;

uniform sampler2D u_tile;
uniform float u_min;
uniform float u_max;

in vec2 v_uv;
out vec4 outColor;

void main() {
  float v = texture(u_tile, v_uv).r;
  if (isnan(v)) {
    outColor = vec4(0.0, 0.0, 0.0, 0.0);
    return;
  }
  float s = clamp((v - u_min) / (u_max - u_min), 0.0, 1.0);
  outColor = vec4(s, s, s, 1.0);
}
`;
