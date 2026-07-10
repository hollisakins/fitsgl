/**
 * Rect-region fragment shader (GLSL ES 3.00) — procedural fill + stroke + dash.
 *
 * A signed box distance field in the rect's own frame (buffer px): negative
 * inside the fill, |sd| ≤ strokeWidth/2 is the stroke band straddling the border.
 * Fill and stroke are composited in one fragment with straight (non-premultiplied)
 * alpha, matching the viewer's global `SRC_ALPHA, ONE_MINUS_SRC_ALPHA` blend and
 * DEPTH_TEST/CULL_FACE staying off. No sampler is read (so a stale tile texture on
 * unit 0 can't leak in). AA via `fwidth` on the distance field.
 *
 * Dashes run per-edge: the arc-length parameter is the fragment's coordinate
 * along whichever edge it is nearest, so the pattern resets at each corner — the
 * DS9-ish look CAMPFIRE wants for stuck-closed shutters, without perimeter
 * bookkeeping. Dash lengths are screen-constant (CSS px → buffer px in the vert).
 */
export const REGION_RECT_FRAG = `#version 300 es
precision highp float;

in vec2 v_local;
in vec2 v_half;
in vec4 v_fill;
in vec4 v_stroke;
in float v_strokeW;
in float v_dashOn;
in float v_dashOff;

out vec4 outColor;

void main() {
  vec2 q = abs(v_local) - v_half;
  float sd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0); // signed dist to border (neg inside)
  float aa = max(fwidth(sd), 1e-4);

  float fillCov = 1.0 - smoothstep(-aa, aa, sd);
  float sHalf = v_strokeW * 0.5;
  float strokeCov = v_strokeW > 0.0 ? 1.0 - smoothstep(sHalf - aa, sHalf + aa, abs(sd)) : 0.0;

  // Per-edge dash mask.
  float period = v_dashOn + v_dashOff;
  if (v_dashOn > 0.0 && period > 0.0) {
    float distVert = v_half.x - abs(v_local.x);   // to a vertical (left/right) edge
    float distHoriz = v_half.y - abs(v_local.y);  // to a horizontal (top/bottom) edge
    float s = distVert < distHoriz ? v_local.y : v_local.x;
    float f = fract(s / period) * period;         // position within the dash cycle, buffer px
    float edge = max(aa, 0.75);
    float dashMask = 1.0 - smoothstep(v_dashOn - edge, v_dashOn + edge, f);
    strokeCov *= dashMask;
  }

  // Composite stroke over fill (straight alpha, un-premultiplied output).
  float fa = v_fill.a * fillCov;
  float sa = v_stroke.a * strokeCov;
  float outA = sa + fa * (1.0 - sa);
  if (outA <= 0.0) discard;
  vec3 rgb = (v_stroke.rgb * sa + v_fill.rgb * fa * (1.0 - sa)) / outA;
  outColor = vec4(rgb, outA);
}
`;
