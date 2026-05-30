/**
 * Marker vertex shader (GLSL ES 3.00) — instanced screen-aligned glyphs (M3).
 *
 * Each instance is a screen-sized glyph at a fixed world position. The CENTRE is
 * projected through the oriented view transform — a literal transcription of
 * `view-transform.ts` `worldToScreen` + the NDC y-flip (= `projectWorldToNdc`,
 * which the tile path also uses) — so markers register with the tiles under
 * pan/zoom and North-up. The orientation is uploaded as a plain `vec4`
 * `(m00,m01,m10,m11)` and applied by `applyOrient`, whose body is character-for-
 * character `applyMat2(m,x,y) = (m0*x+m1*y, m2*x+m3*y)`. This deliberately avoids
 * a GLSL `mat2` uniform: `mat2` is column-major, so uploading the row-major
 * `Mat2` array into one would silently transpose it (the *opposite* rotation,
 * invisible until a real roll) — the B1 trap from the design review.
 *
 * The CORNER offset is added in NDC *after* projection, un-rotated and per-axis,
 * so the glyph stays screen-aligned and constant-pixel-size at every zoom and
 * orientation (a box stays upright; a circle stays round) — matching the
 * screen-space CPU hit-test. `size`/`edgeWidth` are CSS px → buffer px via
 * `u_pixelRatio`; the quad is padded by edge + 1px so the AA fringe isn't clipped.
 *
 * Attribute locations (must match `overlay-renderer.ts`):
 *   0 a_quad (vec2, [-1,1], divisor 0)   1 a_center (vec2 world, divisor 1)
 *   2 a_style (vec3 size,shape,edge, /1)  3 a_color (vec4 rgba, /1)
 */
export const MARKER_VERT = `#version 300 es
layout(location = 0) in vec2 a_quad;     // unit quad corner in [-1, 1]
layout(location = 1) in vec2 a_center;   // marker centre, world (native) px
layout(location = 2) in vec3 a_style;    // size (CSS px), shapeId, edgeWidth (CSS px)
layout(location = 3) in vec4 a_color;    // rgba in [0, 1]

uniform vec2 u_center;     // camera centre, world px
uniform float u_zoom;      // drawing-buffer px per world px
uniform vec2 u_viewport;   // drawing-buffer size (px)
uniform vec4 u_orient;     // row-major Mat2 [m00, m01, m10, m11]
uniform float u_pixelRatio;

out vec2 v_local;          // buffer px from the glyph centre (for the SDF)
out float v_radius;        // glyph radius, buffer px
out float v_edge;          // stroke width, buffer px
flat out int v_shape;      // 0 point, 1 circle, 2 box
out vec4 v_color;

// Mirror of view-transform.ts applyMat2(m, x, y).
vec2 applyOrient(vec4 m, vec2 v) {
  return vec2(m.x * v.x + m.y * v.y, m.z * v.x + m.w * v.y);
}

void main() {
  // Centre: world -> oriented drawing-buffer (y-down) -> NDC (y-up). Matches
  // projectWorldToNdc bit-for-bit.
  vec2 rel = (a_center - u_center) * u_zoom;
  vec2 screen = applyOrient(u_orient, rel) + u_viewport * 0.5;
  vec2 centerNdc = vec2(screen.x / u_viewport.x * 2.0 - 1.0, 1.0 - screen.y / u_viewport.y * 2.0);

  float radius = a_style.x * u_pixelRatio * 0.5;
  float edge = a_style.z * u_pixelRatio;
  float halfExtent = radius + edge + 1.0; // + AA margin so the fringe isn't clipped

  // Corner offset is NOT rotated by u_orient: glyphs are screen-aligned. Per-axis
  // division handles non-square canvases. y is negated for the NDC y-flip.
  vec2 cornerPx = a_quad * halfExtent;
  vec2 cornerNdc = vec2(cornerPx.x / u_viewport.x * 2.0, -cornerPx.y / u_viewport.y * 2.0);

  gl_Position = vec4(centerNdc + cornerNdc, 0.0, 1.0);

  v_local = cornerPx;
  v_radius = radius;
  v_edge = edge;
  v_shape = int(a_style.y + 0.5);
  v_color = a_color;
}
`;
