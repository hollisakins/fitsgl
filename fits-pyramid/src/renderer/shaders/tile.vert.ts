/**
 * Tile vertex shader (GLSL ES 3.00).
 *
 * The renderer draws each tile as a unit quad (attribute `a_quad` in 0..1). Two
 * uniforms place it: `u_rect` is the tile's destination rectangle in clip space
 * (NDC), `u_uv` is the source rectangle in texture space. `mix(a, b, t)` with the
 * 0..1 quad linearly interpolates each corner, so a partial/fallback tile is just
 * a different `u_uv` — no per-vertex data needed.
 */
export const TILE_VERT = `#version 300 es
layout(location = 0) in vec2 a_quad;   // unit quad, 0..1

uniform vec4 u_rect;  // NDC destination: (x0, y0) at a_quad=0, (x1, y1) at a_quad=1
uniform vec4 u_uv;    // texcoord source:  (u0, v0) at a_quad=0, (u1, v1) at a_quad=1

out vec2 v_uv;

void main() {
  vec2 ndc = mix(u_rect.xy, u_rect.zw, a_quad);
  v_uv = mix(u_uv.xy, u_uv.zw, a_quad);
  gl_Position = vec4(ndc, 0.0, 1.0);
}
`;
