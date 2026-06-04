/**
 * Marker fragment shader (GLSL ES 3.00) — procedural disc/ring/box (M3).
 *
 * Purely procedural (no sampler — so it never reads a stale tile texture left
 * bound on unit 0 by the tile pass) with `fwidth`-based antialiasing. The shape
 * id matches `markers.ts` `SHAPE_IDS` (0 point, 1 circle, 2 box); `marker.frag`'s
 * branch order is pinned in `overlay-shader.test.ts` against that map so a swap
 * is caught without a GL context.
 *
 * Output is STRAIGHT (non-premultiplied) alpha: the viewer's global blend is
 * `SRC_ALPHA, ONE_MINUS_SRC_ALPHA`, so `outColor = vec4(rgb, a * coverage)`
 * blends the AA edge correctly over the tiles. The marker pass relies on that
 * global blend state and on DEPTH_TEST/CULL_FACE staying off (both true in the
 * viewer); markers paint over tiles in submission order.
 */
export const MARKER_FRAG = `#version 300 es
precision highp float;

in vec2 v_local;       // buffer px from glyph centre
in float v_radius;     // glyph radius, buffer px
in float v_edge;       // stroke width, buffer px
flat in int v_shape;   // 0 point, 1 circle, 2 box
in vec4 v_color;

out vec4 outColor;

void main() {
  float coverage;
  if (v_shape == 2) {
    // Box outline: Chebyshev distance to the centre.
    vec2 a = abs(v_local);
    float cheb = max(a.x, a.y);
    float aa = fwidth(cheb);
    float inner = v_radius - max(v_edge, 1.0);
    float outside = 1.0 - smoothstep(v_radius - aa, v_radius + aa, cheb);
    float hole = 1.0 - smoothstep(inner - aa, inner + aa, cheb);
    coverage = outside - hole;
  } else if (v_shape == 1) {
    // Circle outline: ring between (radius - edge) and radius.
    float d = length(v_local);
    float aa = fwidth(d);
    float inner = v_radius - max(v_edge, 1.0);
    float outside = 1.0 - smoothstep(v_radius - aa, v_radius + aa, d);
    float hole = 1.0 - smoothstep(inner - aa, inner + aa, d);
    coverage = outside - hole;
  } else {
    // Point: filled disc.
    float d = length(v_local);
    float aa = fwidth(d);
    coverage = 1.0 - smoothstep(v_radius - aa, v_radius + aa, d);
  }
  coverage = clamp(coverage, 0.0, 1.0);
  if (coverage <= 0.0) discard;
  outColor = vec4(v_color.rgb, v_color.a * coverage);
}
`;
