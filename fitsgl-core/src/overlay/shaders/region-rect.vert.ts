/**
 * Rect-region vertex shader (GLSL ES 3.00) — instanced, world-sized, rotatable.
 *
 * Unlike the marker shader (whose corner offset is added in NDC *after*
 * projection, so glyphs are screen-aligned and constant-pixel-size), a region
 * corner is built in WORLD space — `centre ± halfExtent · axis` — so the rect
 * scales with zoom and turns with both its own position angle (`a_axisU/V`, baked
 * into world space by the store) and the display orientation (`u_orient`). The
 * projection (`worldToScreen` + NDC flip) is the same transcription of
 * `view-transform.ts` `projectWorldToNdc` the marker + tile paths use, so regions
 * register with the tiles under pan/zoom/North-up.
 *
 * The quad is padded outward by `strokeWidth/2 + 1px` (screen px) so the outside
 * half of the stroke and its AA fringe are not clipped by the fill rectangle. The
 * fragment shader gets `v_local` (buffer px in the rect's own frame, from the
 * centre) and `v_half` (the fill half-extents, buffer px) to run a box SDF.
 *
 * `a_axisU`/`a_axisV` are unit world directions; `u_orient` is orthogonal, so
 * projecting them preserves length and the screen axes stay unit — the rect's
 * on-screen half-size is `a_half * u_zoom` along each axis.
 *
 * Attribute locations (must match `region-renderer.ts`):
 *   0 a_quad (vec2 [-1,1] /0)  1 a_center (vec2 world /1)  2 a_half (vec2 world /1)
 *   3 a_axisU (vec2 /1)  4 a_axisV (vec2 /1)  5 a_fill (vec4 /1)
 *   6 a_stroke (vec4 /1)  7 a_style (vec3 strokeW,dashOn,dashOff CSS px /1)
 */
export const REGION_RECT_VERT = `#version 300 es
layout(location = 0) in vec2 a_quad;
layout(location = 1) in vec2 a_center;
layout(location = 2) in vec2 a_half;
layout(location = 3) in vec2 a_axisU;
layout(location = 4) in vec2 a_axisV;
layout(location = 5) in vec4 a_fill;
layout(location = 6) in vec4 a_stroke;
layout(location = 7) in vec3 a_style;

uniform vec2 u_center;
uniform float u_zoom;
uniform vec2 u_viewport;
uniform vec4 u_orient;
uniform float u_pixelRatio;

out vec2 v_local;      // buffer px in the rect frame, from the centre
out vec2 v_half;       // fill half-extents, buffer px
out vec4 v_fill;
out vec4 v_stroke;
out float v_strokeW;   // buffer px
out float v_dashOn;    // buffer px
out float v_dashOff;   // buffer px

vec2 applyOrient(vec4 m, vec2 v) {
  return vec2(m.x * v.x + m.y * v.y, m.z * v.x + m.w * v.y);
}

void main() {
  vec2 centerScreen = applyOrient(u_orient, (a_center - u_center) * u_zoom) + u_viewport * 0.5;
  // Unit rect axes in screen space (u_orient is orthogonal → still unit length).
  vec2 su = applyOrient(u_orient, a_axisU);
  vec2 sv = applyOrient(u_orient, a_axisV);
  vec2 halfScreen = a_half * u_zoom;               // buffer px along U, V
  float pad = a_style.x * u_pixelRatio * 0.5 + 1.0; // stroke half + AA margin

  vec2 ext = halfScreen + pad;
  vec2 posScreen = centerScreen + a_quad.x * ext.x * su + a_quad.y * ext.y * sv;
  gl_Position = vec4(posScreen.x / u_viewport.x * 2.0 - 1.0, 1.0 - posScreen.y / u_viewport.y * 2.0, 0.0, 1.0);

  v_local = a_quad * ext;
  v_half = halfScreen;
  v_fill = a_fill;
  v_stroke = a_stroke;
  v_strokeW = a_style.x * u_pixelRatio;
  v_dashOn = a_style.y * u_pixelRatio;
  v_dashOff = a_style.z * u_pixelRatio;
}
`;
