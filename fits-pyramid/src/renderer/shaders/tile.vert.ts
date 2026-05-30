/**
 * Tile vertex shader (GLSL ES 3.00).
 *
 * The renderer draws each tile as a unit quad (attribute `a_quad` in 0..1). The
 * destination is given as its four NDC corners (`u_p00`..`u_p11`, one per quad
 * corner) and the source as a texcoord rectangle (`u_uv`). Bilinear interpolation
 * of the four corners lets the destination be any quad — in particular the
 * rotated/flipped quad the North-up view transform (M2) produces — not just the
 * axis-aligned rectangle the original two-corner `u_rect` could express. The
 * viewer computes the corners on the CPU via the oriented world->screen->NDC
 * transform; with North-up off they form an axis-aligned rect, exactly as before.
 */
export const TILE_VERT = `#version 300 es
layout(location = 0) in vec2 a_quad;   // unit quad, 0..1

uniform vec2 u_p00;   // NDC corner at a_quad = (0, 0)
uniform vec2 u_p10;   // NDC corner at a_quad = (1, 0)
uniform vec2 u_p01;   // NDC corner at a_quad = (0, 1)
uniform vec2 u_p11;   // NDC corner at a_quad = (1, 1)
uniform vec4 u_uv;    // texcoord source: (u0, v0) at a_quad=0, (u1, v1) at a_quad=1

out vec2 v_uv;

void main() {
  vec2 top = mix(u_p00, u_p10, a_quad.x);
  vec2 bot = mix(u_p01, u_p11, a_quad.x);
  vec2 ndc = mix(top, bot, a_quad.y);
  v_uv = mix(u_uv.xy, u_uv.zw, a_quad);
  gl_Position = vec4(ndc, 0.0, 1.0);
}
`;
