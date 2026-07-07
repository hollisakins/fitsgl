/**
 * Polygon-fill fragment shader (GLSL ES 3.00) — flat straight-alpha fill.
 *
 * The triangulated fill tiles the polygon interior (no overlaps from ear-clip), so
 * a plain straight-alpha output blends correctly under the viewer's global
 * `SRC_ALPHA, ONE_MINUS_SRC_ALPHA`. The fill boundary is not antialiased here — the
 * stroke pass drawn on top covers it (and a fill-only polygon with alpha reads as
 * a soft region regardless). No sampler is read.
 */
export const REGION_POLY_FILL_FRAG = `#version 300 es
precision highp float;

in vec4 v_color;
out vec4 outColor;

void main() {
  if (v_color.a <= 0.0) discard;
  outColor = v_color;
}
`;
