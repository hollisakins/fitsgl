/**
 * Polygon-fill vertex shader (GLSL ES 3.00) — non-instanced triangulated fill.
 *
 * Polygons are few (footprints), so their fill triangles are packed into one
 * buffer (`polygon.ts` `buildPolygonFill`) with a per-vertex world position + fill
 * colour and drawn in a single `gl.TRIANGLES` pass. The projection is the shared
 * `worldToScreen` + NDC flip (identical to the rect/marker/tile paths), so a
 * footprint registers with the image under pan/zoom/North-up.
 *
 * Attribute locations (must match `region-renderer.ts`):
 *   0 a_pos (vec2 world)   1 a_color (vec4 fill rgba)
 */
export const REGION_POLY_FILL_VERT = `#version 300 es
layout(location = 0) in vec2 a_pos;
layout(location = 1) in vec4 a_color;

uniform vec2 u_center;
uniform float u_zoom;
uniform vec2 u_viewport;
uniform vec4 u_orient;

out vec4 v_color;

vec2 applyOrient(vec4 m, vec2 v) {
  return vec2(m.x * v.x + m.y * v.y, m.z * v.x + m.w * v.y);
}

void main() {
  vec2 screen = applyOrient(u_orient, (a_pos - u_center) * u_zoom) + u_viewport * 0.5;
  gl_Position = vec4(screen.x / u_viewport.x * 2.0 - 1.0, 1.0 - screen.y / u_viewport.y * 2.0, 0.0, 1.0);
  v_color = a_color;
}
`;
