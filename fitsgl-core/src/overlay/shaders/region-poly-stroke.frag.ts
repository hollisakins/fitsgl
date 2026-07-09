/**
 * Polygon-stroke fragment shader (GLSL ES 3.00) — AA width + screen-constant dash.
 *
 * `v_edge` is the signed distance from the edge centreline (buffer px). Coverage is
 * a `fwidth`-scaled 1px ramp of the box distance `v_half - |v_edge|` (matching the
 * rect fragment's AA), so the interior is fully opaque and only the outer ~1px
 * fades — a thin (<=1px) stroke no longer under-fills at its centre. `v_s` is the arc-length position in
 * buffer px, so dashes are a constant on-screen length at every zoom (the pattern
 * flows continuously across an edge; it may double up slightly in the extended
 * join region, which reads fine for opaque strokes). Straight-alpha output for the
 * viewer's global blend.
 */
export const REGION_POLY_STROKE_FRAG = `#version 300 es
precision highp float;

in vec4 v_color;
in float v_edge;
in float v_half;
in float v_s;
in float v_dashOn;
in float v_dashOff;

out vec4 outColor;

void main() {
  float aa = max(fwidth(v_edge), 1e-4);
  float cov = clamp((v_half - abs(v_edge)) / aa + 0.5, 0.0, 1.0);
  float period = v_dashOn + v_dashOff;
  if (v_dashOn > 0.0 && period > 0.0) {
    float f = fract(v_s / period) * period;
    float edge = 0.75;
    cov *= 1.0 - smoothstep(v_dashOn - edge, v_dashOn + edge, f);
  }
  float a = v_color.a * cov;
  if (a <= 0.0) discard;
  outColor = vec4(v_color.rgb, a);
}
`;
