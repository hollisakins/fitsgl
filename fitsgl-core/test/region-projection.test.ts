import { describe, it, expect } from 'vitest';
import {
  applyMat2,
  projectWorldToNdc,
  worldToScreen,
  IDENTITY_MAT2,
  type Mat2,
  type ViewParams,
} from '../src/renderer/view-transform.js';
import { REGION_RECT_VERT } from '../src/overlay/shaders/region-rect.vert.js';
import { REGION_RECT_FRAG } from '../src/overlay/shaders/region-rect.frag.js';
import { REGION_POLY_FILL_VERT } from '../src/overlay/shaders/region-poly-fill.vert.js';
import { REGION_POLY_FILL_FRAG } from '../src/overlay/shaders/region-poly-fill.frag.js';
import { REGION_POLY_STROKE_VERT } from '../src/overlay/shaders/region-poly-stroke.vert.js';
import { REGION_POLY_STROKE_FRAG } from '../src/overlay/shaders/region-poly-stroke.frag.js';
import { resolveRect, type ResolvedRect, type ResolvedStyle } from '../src/overlay/regions.js';

const view: ViewParams = { centerX: 123, centerY: 321, zoom: 1.7, viewportWidth: 800, viewportHeight: 600 };
const STYLE: ResolvedStyle = { fill: [0, 0, 0, 0], stroke: [1, 1, 1, 1], strokeWidth: 1, dashOn: 0, dashOff: 0, data: {} };

/** JS twin of the rect vertex shader's UNPADDED corner projection (pad=0). */
function shaderRectCornerNdc(orient: Mat2, r: ResolvedRect, qx: number, qy: number): { x: number; y: number } {
  const c = worldToScreen(view, orient, r.centerX, r.centerY);
  const su = applyMat2(orient, r.axisU[0], r.axisU[1]);
  const sv = applyMat2(orient, r.axisV[0], r.axisV[1]);
  const hx = r.halfW * view.zoom;
  const hy = r.halfH * view.zoom;
  const sx = c.x + qx * hx * su.x + qy * hy * sv.x;
  const sy = c.y + qx * hx * su.y + qy * hy * sv.y;
  return { x: (sx / view.viewportWidth) * 2 - 1, y: 1 - (sy / view.viewportHeight) * 2 };
}

describe('rect vertex shader — projects corners to the same NDC as the tile path', () => {
  it('a corner built in world space lands where projectWorldToNdc puts it', () => {
    const orients: Mat2[] = [
      IDENTITY_MAT2,
      [Math.cos(0.7), -Math.sin(0.7), Math.sin(0.7), Math.cos(0.7)],
      [-0.8, 0.2, 0.2, 0.8], // mirror parity
    ];
    const r = resolveRect({ x: 199.5, y: 249.5, width: 40, height: 16, rotationDeg: 25 }, null, STYLE, 'a') as ResolvedRect;
    for (const orient of orients) {
      for (const [qx, qy] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ]) {
        // World corner = centre ± halfW·U ± halfH·V (the shader's construction).
        const cornerWorld = {
          x: r.centerX + qx * r.halfW * r.axisU[0] + qy * r.halfH * r.axisV[0],
          y: r.centerY + qx * r.halfW * r.axisU[1] + qy * r.halfH * r.axisV[1],
        };
        const expected = projectWorldToNdc(view, orient, cornerWorld.x, cornerWorld.y);
        const got = shaderRectCornerNdc(orient, r, qx, qy);
        expect(got.x).toBeCloseTo(expected.x, 12);
        expect(got.y).toBeCloseTo(expected.y, 12);
      }
    }
  });

  it('the four resolved corners round-trip through the shader projection', () => {
    const orient: Mat2 = [0, -1, 1, 0];
    const r = resolveRect({ x: 10.5, y: 20.5, width: 6, height: 6, rotationDeg: 40 }, null, STYLE, 'a') as ResolvedRect;
    const quads = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ];
    r.corners.forEach((corner, i) => {
      const expected = projectWorldToNdc(view, orient, corner.x, corner.y);
      const got = shaderRectCornerNdc(orient, r, quads[i][0], quads[i][1]);
      expect(got.x).toBeCloseTo(expected.x, 10);
      expect(got.y).toBeCloseTo(expected.y, 10);
    });
  });
});

describe('region shaders — structural pins', () => {
  it('the rect shader uses a vec4 orient (no mat2 transpose trap) and builds the corner in world', () => {
    expect(REGION_RECT_VERT).toContain('uniform vec4 u_orient;');
    expect(REGION_RECT_VERT).not.toContain('mat2');
    expect(REGION_RECT_VERT).toContain('m.x * v.x + m.y * v.y');
    // The corner is built from the world axes BEFORE projection (world-sized).
    expect(REGION_RECT_VERT).toContain('a_quad.x * ext.x * su');
    expect(REGION_RECT_VERT).toContain('a_style.x * u_pixelRatio * 0.5 + 1.0'); // stroke half + AA pad
  });

  it('declares the seven per-instance attribute locations the renderer binds', () => {
    expect(REGION_RECT_VERT).toContain('layout(location = 0) in vec2 a_quad');
    expect(REGION_RECT_VERT).toContain('layout(location = 1) in vec2 a_center');
    expect(REGION_RECT_VERT).toContain('layout(location = 2) in vec2 a_half');
    expect(REGION_RECT_VERT).toContain('layout(location = 3) in vec2 a_axisU');
    expect(REGION_RECT_VERT).toContain('layout(location = 4) in vec2 a_axisV');
    expect(REGION_RECT_VERT).toContain('layout(location = 5) in vec4 a_fill');
    expect(REGION_RECT_VERT).toContain('layout(location = 6) in vec4 a_stroke');
    expect(REGION_RECT_VERT).toContain('layout(location = 7) in vec3 a_style');
  });

  it('the rect fragment composites fill+stroke in straight alpha and reads no sampler', () => {
    expect(REGION_RECT_FRAG.startsWith('#version 300 es')).toBe(true);
    expect(REGION_RECT_FRAG).toContain('length(max(q, 0.0)) + min(max(q.x, q.y), 0.0)'); // box SDF
    expect(REGION_RECT_FRAG).toContain('v_dashOn'); // dashed stroke path
    expect(REGION_RECT_FRAG).not.toContain('sampler2D');
  });

  it('the polygon shaders project through the shared transform and never read a sampler', () => {
    for (const src of [REGION_POLY_FILL_VERT, REGION_POLY_STROKE_VERT]) {
      expect(src).toContain('uniform vec4 u_orient;');
      expect(src).toContain('m.x * v.x + m.y * v.y'); // applyOrient transcription
    }
    expect(REGION_POLY_STROKE_VERT).toContain('normal * side * hw'); // screen-space expansion
    expect(REGION_POLY_STROKE_VERT).not.toContain('float half'); // 'half' is a GLSL ES reserved word
    expect(REGION_POLY_STROKE_FRAG).toContain('v_dashOn');
    expect(REGION_POLY_FILL_FRAG).not.toContain('sampler2D');
    expect(REGION_POLY_STROKE_FRAG).not.toContain('sampler2D');
  });
});
