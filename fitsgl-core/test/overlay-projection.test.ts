import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  applyMat2,
  projectWorldToNdc,
  worldToScreen,
  IDENTITY_MAT2,
  type Mat2,
  type ViewParams,
} from '../src/renderer/view-transform.js';
import { MARKER_VERT } from '../src/overlay/shaders/marker.vert.js';
import { MARKER_FRAG } from '../src/overlay/shaders/marker.frag.js';
import { SHAPE_IDS } from '../src/overlay/markers.js';
import { parseWcs, skyToPix, type TanWcs } from '../src/wcs/tan.js';

const FIX_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const wcsFix = JSON.parse(readFileSync(join(FIX_DIR, 'wcs_fixtures.json'), 'utf8')) as {
  configs: Array<{ name: string; wcs: Record<string, unknown>; p2w: Array<{ x0: number; y0: number; ra: number; dec: number }> }>;
};

const view: ViewParams = { centerX: 123, centerY: 321, zoom: 1.7, viewportWidth: 800, viewportHeight: 600 };

describe('projectWorldToNdc — the pure twin of the marker vertex shader', () => {
  it('equals the documented worldToScreen -> NDC y-flip composition under any orientation', () => {
    const orients: Mat2[] = [
      IDENTITY_MAT2,
      [1, 0, 0, -1], // North-up flip (standard parity)
      [Math.cos(0.6), -Math.sin(0.6), Math.sin(0.6), Math.cos(0.6)], // a 0.6 rad rotation
      [-0.8, 0.2, 0.2, 0.8], // mirror parity
    ];
    for (const orient of orients) {
      for (const [wx, wy] of [
        [0, 0],
        [123, 321],
        [500, -40],
      ]) {
        const got = projectWorldToNdc(view, orient, wx, wy);
        const s = worldToScreen(view, orient, wx, wy);
        expect(got.x).toBeCloseTo((s.x / view.viewportWidth) * 2 - 1, 12);
        expect(got.y).toBeCloseTo(1 - (s.y / view.viewportHeight) * 2, 12);
      }
    }
  });

  it('puts the camera centre at the NDC origin regardless of orientation', () => {
    const orient: Mat2 = [Math.cos(1), -Math.sin(1), Math.sin(1), Math.cos(1)];
    const c = projectWorldToNdc(view, orient, view.centerX, view.centerY);
    expect(c.x).toBeCloseTo(0, 12);
    expect(c.y).toBeCloseTo(0, 12);
  });

  it('a sky marker projects to the same NDC as its fixture pixel (astropy-gated chain)', () => {
    // ra/dec --skyToPix--> world --projectWorldToNdc--> NDC must coincide with the
    // pixel the fixture says that sky position sits at. This is the chain the
    // marker shader walks; both ends are pinned here.
    for (const cfg of wcsFix.configs) {
      const wcs = parseWcs(cfg.wcs) as TanWcs;
      const orient: Mat2 = [0, -1, 1, 0]; // 90 deg, a non-trivial orientation
      for (const s of cfg.p2w) {
        const fromSky = skyToPix(wcs, s.ra, s.dec);
        const ndcSky = projectWorldToNdc(view, orient, fromSky.x, fromSky.y);
        const ndcPix = projectWorldToNdc(view, orient, s.x0 + 0.5, s.y0 + 0.5);
        expect(ndcSky.x).toBeCloseTo(ndcPix.x, 6);
        expect(ndcSky.y).toBeCloseTo(ndcPix.y, 6);
      }
    }
  });
});

describe('marker shaders — structural pins (no headless WebGL2 to render against)', () => {
  it('the vertex shader transcribes applyMat2 exactly (orient as a vec4, not a mat2)', () => {
    // The shader avoids a GLSL mat2 uniform (column-major) precisely to dodge the
    // transpose trap; applyOrient mirrors applyMat2(m,x,y) = (m0*x+m1*y, m2*x+m3*y).
    expect(applyMat2([2, 3, 4, 5], 1, 1)).toEqual({ x: 5, y: 9 });
    expect(MARKER_VERT).toContain('vec2 applyOrient(vec4 m, vec2 v)');
    expect(MARKER_VERT).toContain('m.x * v.x + m.y * v.y');
    expect(MARKER_VERT).toContain('m.z * v.x + m.w * v.y');
    expect(MARKER_VERT).toContain('uniform vec4 u_orient;');
    expect(MARKER_VERT).not.toContain('mat2');
  });

  it('the vertex shader applies the NDC y-flip and an un-rotated corner offset', () => {
    expect(MARKER_VERT).toContain('1.0 - screen.y / u_viewport.y * 2.0'); // y-flip, after orient
    expect(MARKER_VERT).toContain('a_quad * halfExtent'); // corner offset NOT through u_orient
    expect(MARKER_VERT).toContain('a_style.x * u_pixelRatio'); // CSS px -> buffer px
  });

  it('declares the attribute locations the overlay renderer binds (0..3)', () => {
    expect(MARKER_VERT).toContain('layout(location = 0) in vec2 a_quad');
    expect(MARKER_VERT).toContain('layout(location = 1) in vec2 a_center');
    expect(MARKER_VERT).toContain('layout(location = 2) in vec3 a_style');
    expect(MARKER_VERT).toContain('layout(location = 3) in vec4 a_color');
  });

  it('the fragment shader branches on the SHAPE_IDS contract and writes straight alpha', () => {
    expect(MARKER_FRAG.startsWith('#version 300 es')).toBe(true);
    expect(MARKER_FRAG).toContain('precision highp float');
    expect(SHAPE_IDS).toEqual({ point: 0, circle: 1, box: 2 });
    expect(MARKER_FRAG).toContain('v_shape == 2'); // box
    expect(MARKER_FRAG).toContain('v_shape == 1'); // circle (point is the else)
    expect(MARKER_FRAG).toContain('v_color.a * coverage'); // straight (non-premultiplied) alpha
    expect(MARKER_FRAG).not.toContain('sampler2D'); // procedural; never reads a stale tile texture
  });
});
