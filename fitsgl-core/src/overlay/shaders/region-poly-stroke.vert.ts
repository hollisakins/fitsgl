/**
 * Polygon-stroke vertex shader (GLSL ES 3.00) — screen-constant expanded edges.
 *
 * Each polygon edge A→B becomes a quad (4 vertices) expanded to a screen-constant
 * width: the endpoints are projected to screen, the edge is offset ±strokeWidth/2
 * along its screen-space normal, and each quad end is extended outward by
 * strokeWidth/2 along the edge tangent so adjacent edges overlap into a filled
 * (bevel-ish) join. Building the offset in screen space keeps a 1px outline 1px at
 * every zoom while the endpoints stay in world space (so the geometry is static —
 * no per-frame rebuild).
 *
 * Both endpoints are supplied on every vertex (`a_a`, `a_b`) so the edge direction
 * (hence the normal) is computed consistently regardless of which endpoint the
 * vertex sits at — computing it from only the local endpoint would flip the normal
 * at B and twist the quad into a bowtie.
 *
 * `a_param = (t, side)`: `t` ∈ {0,1} selects endpoint A or B; `side` ∈ {−1,+1} the
 * offset direction. `a_arc = (sA, sB)`: cumulative WORLD arc-length at A and B; the
 * fragment dashes against `v_s` (buffer px) = arc·zoom + the end extension.
 *
 * Attribute locations (must match `region-renderer.ts`):
 *   0 a_a (vec2 world A)  1 a_b (vec2 world B)  2 a_param (vec2 t,side)
 *   3 a_arc (vec2 sA,sB)  4 a_color (vec4)  5 a_style (vec3 strokeW,dashOn,dashOff CSS px)
 */
export const REGION_POLY_STROKE_VERT = `#version 300 es
layout(location = 0) in vec2 a_a;
layout(location = 1) in vec2 a_b;
layout(location = 2) in vec2 a_param;   // (t, side)
layout(location = 3) in vec2 a_arc;     // (sA, sB) world arc-length
layout(location = 4) in vec4 a_color;
layout(location = 5) in vec3 a_style;   // strokeW, dashOn, dashOff (CSS px)

uniform vec2 u_center;
uniform float u_zoom;
uniform vec2 u_viewport;
uniform vec4 u_orient;
uniform float u_pixelRatio;

out vec4 v_color;
out float v_edge;      // signed distance from the centreline, buffer px
out float v_half;      // stroke half-width, buffer px
out float v_s;         // arc-length position, buffer px (for dashing)
out float v_dashOn;    // buffer px
out float v_dashOff;   // buffer px

vec2 applyOrient(vec4 m, vec2 v) {
  return vec2(m.x * v.x + m.y * v.y, m.z * v.x + m.w * v.y);
}
vec2 worldToScreen(vec2 world) {
  return applyOrient(u_orient, (world - u_center) * u_zoom) + u_viewport * 0.5;
}

void main() {
  vec2 sA = worldToScreen(a_a);
  vec2 sB = worldToScreen(a_b);
  vec2 dir = sB - sA;
  float len = length(dir);
  dir = len > 1e-6 ? dir / len : vec2(1.0, 0.0);
  vec2 normal = vec2(-dir.y, dir.x);

  float hw = a_style.x * u_pixelRatio * 0.5;  // stroke half-width, buffer px
  float t = a_param.x;
  float side = a_param.y;
  float extendSign = t < 0.5 ? -1.0 : 1.0;   // extend beyond A (−dir) or B (+dir)

  vec2 base = mix(sA, sB, t);
  vec2 posScreen = base + normal * side * hw + dir * extendSign * hw;
  gl_Position = vec4(posScreen.x / u_viewport.x * 2.0 - 1.0, 1.0 - posScreen.y / u_viewport.y * 2.0, 0.0, 1.0);

  v_color = a_color;
  v_edge = side * hw;
  v_half = hw;
  float sHere = mix(a_arc.x, a_arc.y, t) * u_zoom + extendSign * hw; // buffer px
  v_s = sHere;
  v_dashOn = a_style.y * u_pixelRatio;
  v_dashOff = a_style.z * u_pixelRatio;
}
`;
