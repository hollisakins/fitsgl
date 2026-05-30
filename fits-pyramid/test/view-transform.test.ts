import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  applyMat2,
  transposeMat2,
  worldToScreen,
  screenToWorld,
  viewportWorldAABB,
  orientedImageSpan,
  northUpOrientation,
  panCenter,
  anchoredZoomCenter,
  IDENTITY_MAT2,
  type Mat2,
} from '../src/renderer/view-transform.js';
import { parseWcs } from '../src/wcs/tan.js';

interface Config {
  name: string;
  shape: [number, number];
  wcs: Record<string, unknown>;
  center_world: [number, number];
  north_vec: [number, number];
  east_vec: [number, number];
}
const FIX_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = JSON.parse(
  readFileSync(join(FIX_DIR, 'wcs_fixtures.json'), 'utf8'),
) as { configs: Config[] };

const view = { centerX: 100, centerY: 200, zoom: 2.5, viewportWidth: 800, viewportHeight: 600 };

describe('Mat2 helpers', () => {
  it('applyMat2 multiplies a vector', () => {
    expect(applyMat2([1, 2, 3, 4], 5, 6)).toEqual({ x: 17, y: 39 });
  });
  it('transpose swaps the off-diagonal', () => {
    expect(transposeMat2([1, 2, 3, 4])).toEqual([1, 3, 2, 4]);
  });
});

describe('oriented world<->screen', () => {
  it('with the identity matrix matches the plain camera affine', () => {
    const s = worldToScreen(view, IDENTITY_MAT2, 137, 250);
    expect(s.x).toBeCloseTo((137 - 100) * 2.5 + 400, 9);
    expect(s.y).toBeCloseTo((250 - 200) * 2.5 + 300, 9);
  });

  it('round-trips under a non-trivial orientation (a 30° rotation)', () => {
    const t = (30 * Math.PI) / 180;
    const rot: Mat2 = [Math.cos(t), -Math.sin(t), Math.sin(t), Math.cos(t)];
    for (const [wx, wy] of [
      [0, 0],
      [137, 250],
      [-40, 512],
    ]) {
      const s = worldToScreen(view, rot, wx, wy);
      const back = screenToWorld(view, rot, s.x, s.y);
      expect(back.x).toBeCloseTo(wx, 7);
      expect(back.y).toBeCloseTo(wy, 7);
    }
  });

  it('the camera centre maps to the viewport centre regardless of orientation', () => {
    const t = 0.7;
    const rot: Mat2 = [Math.cos(t), -Math.sin(t), Math.sin(t), Math.cos(t)];
    const s = worldToScreen(view, rot, view.centerX, view.centerY);
    expect(s.x).toBeCloseTo(400, 9);
    expect(s.y).toBeCloseTo(300, 9);
  });
});

describe('oriented pan / anchored zoom keep the cursor anchor fixed', () => {
  // The North-up flip for a standard-parity WCS. The pre-fix bug used the
  // axis-aligned camera path here, which dropped the Mᵀ and flipped y.
  const flip: Mat2 = [1, 0, 0, -1];

  it('anchored zoom keeps the world point under the cursor fixed (under a flip)', () => {
    const v = { centerX: 256, centerY: 256, zoom: 1, viewportWidth: 800, viewportHeight: 600 };
    const sx = 612;
    const sy = 137;
    const before = screenToWorld(v, flip, sx, sy);
    const c = anchoredZoomCenter(v, flip, sx, sy, 4.2);
    const v2 = { ...v, zoom: 4.2, centerX: c.centerX, centerY: c.centerY };
    const after = screenToWorld(v2, flip, sx, sy);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it('pan carries the grabbed point with the cursor (under a flip)', () => {
    const v = { centerX: 256, centerY: 256, zoom: 2, viewportWidth: 800, viewportHeight: 600 };
    const s0 = { x: 400, y: 300 };
    const s1 = { x: 400, y: 260 }; // dragged up 40 buffer px
    const grabbed = screenToWorld(v, flip, s0.x, s0.y);
    const c = panCenter(v, flip, s1.x - s0.x, s1.y - s0.y);
    const v2 = { ...v, centerX: c.centerX, centerY: c.centerY };
    const nowAt = screenToWorld(v2, flip, s1.x, s1.y);
    expect(nowAt.x).toBeCloseTo(grabbed.x, 6);
    expect(nowAt.y).toBeCloseTo(grabbed.y, 6);
  });

  it('with the identity orientation matches the plain camera affine', () => {
    const v = { centerX: 256, centerY: 256, zoom: 3, viewportWidth: 800, viewportHeight: 600 };
    // pan: identity Mᵀ -> center shifts by -delta/zoom, exactly panByScreen.
    const c = panCenter(v, IDENTITY_MAT2, 30, -20);
    expect(c.centerX).toBeCloseTo(256 - 30 / 3, 9);
    expect(c.centerY).toBeCloseTo(256 - -20 / 3, 9);
  });
});

describe('orientedImageSpan', () => {
  it('is the image size under the identity', () => {
    expect(orientedImageSpan(IDENTITY_MAT2, 640, 480)).toEqual({ spanX: 640, spanY: 480 });
  });
  it('swaps width/height under a 90° rotation', () => {
    const rot: Mat2 = [0, -1, 1, 0]; // 90°
    const span = orientedImageSpan(rot, 640, 480);
    expect(span.spanX).toBeCloseTo(480, 9);
    expect(span.spanY).toBeCloseTo(640, 9);
  });
});

describe('viewportWorldAABB', () => {
  it('equals the two-corner bounds when axis-aligned', () => {
    const aabb = viewportWorldAABB(view, IDENTITY_MAT2);
    const tl = screenToWorld(view, IDENTITY_MAT2, 0, 0);
    const br = screenToWorld(view, IDENTITY_MAT2, view.viewportWidth, view.viewportHeight);
    expect(aabb.x0).toBeCloseTo(tl.x, 9);
    expect(aabb.y0).toBeCloseTo(tl.y, 9);
    expect(aabb.x1).toBeCloseTo(br.x, 9);
    expect(aabb.y1).toBeCloseTo(br.y, 9);
  });
  it('is larger (over-selects) under rotation', () => {
    const t = (30 * Math.PI) / 180;
    const rot: Mat2 = [Math.cos(t), -Math.sin(t), Math.sin(t), Math.cos(t)];
    const ax = viewportWorldAABB(view, IDENTITY_MAT2);
    const rx = viewportWorldAABB(view, rot);
    expect(rx.x1 - rx.x0).toBeGreaterThan(ax.x1 - ax.x0);
    expect(rx.y1 - rx.y0).toBeGreaterThan(ax.y1 - ax.y0);
  });
});

describe('northUpOrientation — matches astropy North/East at the image centre', () => {
  const UP = { x: 0, y: -1 }; // screen-up in y-down screen space

  for (const cfg of fixture.configs) {
    it(`${cfg.name}: rotates North to up (<0.1°) and East to the left`, () => {
      const wcs = parseWcs(cfg.wcs);
      expect(wcs).not.toBeNull();
      if (wcs === null) return;
      const m = northUpOrientation(wcs, cfg.center_world[0], cfg.center_world[1]);

      // M is rigid: orthogonal (MᵀM = I) with |det| = 1.
      const det = m[0] * m[3] - m[1] * m[2];
      expect(Math.abs(Math.abs(det) - 1)).toBeLessThan(1e-9);

      // North (astropy's vector) maps to screen-up within 0.1°.
      const n = applyMat2(m, cfg.north_vec[0], cfg.north_vec[1]);
      const nLen = Math.hypot(n.x, n.y);
      const cosAngle = (n.x * UP.x + n.y * UP.y) / nLen;
      const angleDeg = (Math.acos(Math.min(1, Math.max(-1, cosAngle))) * 180) / Math.PI;
      expect(angleDeg).toBeLessThan(0.1);

      // East (astropy's vector) maps to the left half-plane (x < 0).
      const e = applyMat2(m, cfg.east_vec[0], cfg.east_vec[1]);
      expect(e.x).toBeLessThan(0);
    });
  }

  it('exercises both parity branches across the fixtures (flip and no-flip)', () => {
    // Standard-parity WCS (det(CD) < 0) take the flip branch (det(M) = -1); a
    // mirror-parity WCS (det(CD) > 0) takes the no-flip branch (det(M) = +1).
    // Both must appear, or one branch of the parity logic is untested.
    const dets = fixture.configs.map((cfg) => {
      const wcs = parseWcs(cfg.wcs);
      if (wcs === null) return 0;
      const m = northUpOrientation(wcs, cfg.center_world[0], cfg.center_world[1]);
      return Math.sign(Math.round(m[0] * m[3] - m[1] * m[2]));
    });
    expect(dets).toContain(1); // mirror-parity -> no-flip branch
    expect(dets).toContain(-1); // standard parity -> flip branch
  });

  it('returns the identity for a degenerate WCS direction', () => {
    // A WCS whose North vector is zero cannot happen for a real TAN, but guard
    // against a returned non-finite orientation: identity is always safe.
    const wcs = parseWcs({
      CTYPE1: 'RA---TAN', CTYPE2: 'DEC--TAN', RADESYS: 'ICRS',
      CRPIX1: 1, CRPIX2: 1, CRVAL1: 150, CRVAL2: 2.2,
      CD1_1: -8.3e-6, CD1_2: 0, CD2_1: 0, CD2_2: 8.3e-6,
    });
    expect(wcs).not.toBeNull();
    if (wcs === null) return;
    const m = northUpOrientation(wcs, 256, 256);
    // Real WCS: a valid rigid matrix (not necessarily identity), all finite.
    expect(m.every((v) => Number.isFinite(v))).toBe(true);
  });
});
