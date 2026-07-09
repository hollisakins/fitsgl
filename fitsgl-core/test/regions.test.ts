import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  RegionStore,
  inferRegionShape,
  isRegionShape,
  resolveRect,
  resolvePolygon,
  DEFAULT_REGION_STROKE,
  DEFAULT_REGION_FILL,
  DEFAULT_REGION_STROKE_WIDTH,
  type ResolvedRect,
  type ResolvedPolygon,
  type ResolvedStyle,
} from '../src/overlay/regions.js';
import { parseWcs, skyToPix, pixToSky, type TanWcs } from '../src/wcs/tan.js';
import { angularSeparationDeg, positionAngleDeg } from '../src/wcs/index.js';

const FIX_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const wcsFix = JSON.parse(readFileSync(join(FIX_DIR, 'wcs_fixtures.json'), 'utf8')) as {
  configs: Array<{ name: string; wcs: Record<string, unknown> }>;
};
function wcsByName(name: string): TanWcs {
  const cfg = wcsFix.configs.find((c) => c.name === name);
  if (cfg === undefined) throw new Error(`fixture ${name} missing`);
  return parseWcs(cfg.wcs) as TanWcs;
}

const STYLE: ResolvedStyle = {
  fill: [0, 0, 0, 0],
  stroke: [1, 0.8, 0, 1],
  strokeWidth: 1.5,
  dashOn: 0,
  dashOff: 0,
  data: {},
};

/** Great-circle degrees between two resolved-corner world points, via a WCS. */
function sepArcsec(wcs: TanWcs, a: { x: number; y: number }, b: { x: number; y: number }): number {
  return angularSeparationDeg(pixToSky(wcs, a.x, a.y), pixToSky(wcs, b.x, b.y)) * 3600;
}
function mid(a: { x: number; y: number }, b: { x: number; y: number }): { x: number; y: number } {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
/** The four world corners of a resolved rect (BL, BR, TR, TL in (u, v)), derived
 *  from centre + half-extents + axes — matching the rect vertex shader. */
function cornersOf(r: ResolvedRect): Array<{ x: number; y: number }> {
  const c = (su: number, sv: number): { x: number; y: number } => ({
    x: r.centerX + su * r.halfW * r.axisU[0] + sv * r.halfH * r.axisV[0],
    y: r.centerY + su * r.halfW * r.axisU[1] + sv * r.halfH * r.axisV[1],
  });
  return [c(-1, -1), c(1, -1), c(1, 1), c(-1, 1)];
}

describe('region shape inference', () => {
  it('is rect by default, polygon when vertices are present', () => {
    expect(inferRegionShape({})).toBe('rect');
    expect(inferRegionShape({ x: 1, y: 2, width: 3, height: 4 })).toBe('rect');
    expect(inferRegionShape({ worldVertices: [] })).toBe('polygon');
    expect(inferRegionShape({ vertices: [] })).toBe('polygon');
    // An explicit shape overrides the inference.
    expect(inferRegionShape({ shape: 'polygon', x: 1, y: 2 })).toBe('polygon');
  });
  it('isRegionShape narrows to the two shapes', () => {
    expect(isRegionShape('rect')).toBe(true);
    expect(isRegionShape('polygon')).toBe(true);
    expect(isRegionShape('circle')).toBe(false);
  });
});

describe('resolveRect — world geometry', () => {
  it('centres at x+0.5 / y+0.5 and halves the extents', () => {
    const r = resolveRect({ x: 9.5, y: 19.5, width: 8, height: 4 }, null, STYLE, 'a') as ResolvedRect;
    expect(r.centerX).toBe(10);
    expect(r.centerY).toBe(20);
    expect(r.halfW).toBe(4);
    expect(r.halfH).toBe(2);
    // axis-aligned by default
    expect(r.axisU[0]).toBeCloseTo(1, 12);
    expect(r.axisU[1]).toBeCloseTo(0, 12);
    expect(r.axisV[0]).toBeCloseTo(0, 12);
    expect(r.axisV[1]).toBeCloseTo(1, 12);
    expect(r.boundRadius).toBeCloseTo(Math.hypot(4, 2), 12);
  });
  it('rotationDeg rotates the basis CCW', () => {
    const r = resolveRect({ x: -0.5, y: -0.5, width: 2, height: 2, rotationDeg: 90 }, null, STYLE, 'a') as ResolvedRect;
    expect(r.axisU[0]).toBeCloseTo(0, 12);
    expect(r.axisU[1]).toBeCloseTo(1, 12);
    expect(r.axisV[0]).toBeCloseTo(-1, 12);
    expect(r.axisV[1]).toBeCloseTo(0, 12);
  });
  it('places the four corners at ±halfW·U ±halfH·V', () => {
    const r = resolveRect({ x: -0.5, y: -0.5, width: 4, height: 2 }, null, STYLE, 'a') as ResolvedRect;
    // corners order: BL, BR, TR, TL in (u, v)
    const corners = cornersOf(r);
    expect(corners[0]).toEqual({ x: -2, y: -1 });
    expect(corners[2]).toEqual({ x: 2, y: 1 });
  });
});

describe('resolveRect — sky geometry (WCS)', () => {
  it('drops a sky rect when there is no WCS', () => {
    expect(resolveRect({ ra: 150, dec: 2.2, widthArcsec: 60, heightArcsec: 60 }, null, STYLE, 'a')).toBeNull();
  });

  it('drops a sky rect on a non-square-pixel (anisotropic) WCS, but keeps a sky polygon', () => {
    const cfg = wcsFix.configs.find((c) => c.name === 'axis_aligned');
    if (cfg === undefined) throw new Error('fixture axis_aligned missing');
    // Dec pixel scale 2x the RA scale — a sky rect can't be faithfully sized.
    const aniso = parseWcs({ ...cfg.wcs, CDELT2: 2.0 }) as TanWcs;
    expect(resolveRect({ ra: 150, dec: 2.2, widthArcsec: 60, heightArcsec: 60 }, aniso, STYLE, 'a')).toBeNull();
    // Sky POLYGONS project each vertex independently, so they are unaffected.
    const poly = resolvePolygon(
      { vertices: [{ ra: 150, dec: 2.2 }, { ra: 150.02, dec: 2.2 }, { ra: 150.02, dec: 2.22 }] },
      aniso,
      STYLE,
      'p',
    );
    expect(poly).not.toBeNull();
  });

  for (const name of ['axis_aligned', 'rolled_30', 'mirror_parity']) {
    it(`resolves true angular size + PA on ${name}`, () => {
      const wcs = wcsByName(name);
      const paDeg = 30;
      const W = 120;
      const H = 60;
      const r = resolveRect({ ra: 150, dec: 2.2, paDeg, widthArcsec: W, heightArcsec: H }, wcs, STYLE, 'a') as ResolvedRect;
      const center = skyToPix(wcs, 150, 2.2);
      expect(r.centerX).toBeCloseTo(center.x, 6);
      expect(r.centerY).toBeCloseTo(center.y, 6);

      // Corner mid-points along each axis.
      const corners = cornersOf(r);
      const topMid = mid(corners[2], corners[3]); // +axisV edge
      const botMid = mid(corners[0], corners[1]); // −axisV edge
      const rightMid = mid(corners[1], corners[2]); // +axisU edge
      const leftMid = mid(corners[0], corners[3]); // −axisU edge

      // Angular full extents match the requested arcsec (independent of WCS roll/parity).
      expect(sepArcsec(wcs, topMid, botMid)).toBeCloseTo(H, 3);
      expect(sepArcsec(wcs, rightMid, leftMid)).toBeCloseTo(W, 3);

      // Position angle of the +height axis (East of North) matches paDeg.
      const cs = pixToSky(wcs, r.centerX, r.centerY);
      const ts = pixToSky(wcs, topMid.x, topMid.y);
      let pa = positionAngleDeg(cs, ts);
      pa = ((pa % 360) + 360) % 360;
      expect(Math.min(Math.abs(pa - paDeg), 360 - Math.abs(pa - paDeg))).toBeLessThan(0.5);
    });
  }

  it('paDeg=0 points the height axis North (increasing Dec)', () => {
    const wcs = wcsByName('axis_aligned');
    const r = resolveRect({ ra: 150, dec: 2.2, paDeg: 0, widthArcsec: 60, heightArcsec: 60 }, wcs, STYLE, 'a') as ResolvedRect;
    const topMid = mid(cornersOf(r)[2], cornersOf(r)[3]);
    const center = pixToSky(wcs, r.centerX, r.centerY);
    const top = pixToSky(wcs, topMid.x, topMid.y);
    expect(top.dec).toBeGreaterThan(center.dec);
  });
});

describe('resolvePolygon', () => {
  it('resolves world vertices (each +0.5), centroid and bound-radius', () => {
    const p = resolvePolygon(
      { worldVertices: [{ x: -0.5, y: -0.5 }, { x: 3.5, y: -0.5 }, { x: 3.5, y: 3.5 }, { x: -0.5, y: 3.5 }] },
      null,
      STYLE,
      'p',
    ) as ResolvedPolygon;
    expect(p.worldVertices[0]).toEqual({ x: 0, y: 0 });
    expect(p.worldVertices[2]).toEqual({ x: 4, y: 4 });
    expect(p.centerX).toBeCloseTo(2, 12);
    expect(p.centerY).toBeCloseTo(2, 12);
    expect(p.boundRadius).toBeCloseTo(Math.hypot(2, 2), 12);
  });
  it('drops a polygon with fewer than 3 vertices', () => {
    expect(resolvePolygon({ worldVertices: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }, null, STYLE, 'p')).toBeNull();
  });
  it('drops a sky polygon with no WCS', () => {
    expect(resolvePolygon({ vertices: [{ ra: 1, dec: 1 }, { ra: 2, dec: 1 }, { ra: 2, dec: 2 }] }, null, STYLE, 'p')).toBeNull();
  });
});

describe('RegionStore', () => {
  it('adds, indexes, and separates rects from polygons', () => {
    const s = new RegionStore();
    const ids = s.add(
      [
        { id: 'a', x: 0, y: 0, width: 2, height: 2 },
        { id: 'b', worldVertices: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 2, y: 4 }] },
      ],
      null,
    );
    expect(ids).toEqual(['a', 'b']);
    expect(s.count).toBe(2);
    expect(s.rects().map((r) => r.rect.id)).toEqual(['a']);
    expect(s.polygons().map((p) => p.polygon.id)).toEqual(['b']);
    expect(s.rects()[0].index).toBe(0);
    expect(s.polygons()[0].index).toBe(1);
  });

  it('auto-assigns ids and throws on a duplicate', () => {
    const s = new RegionStore();
    const [auto] = s.add([{ x: 0, y: 0, width: 1, height: 1 }], null);
    expect(typeof auto).toBe('string');
    expect(() => s.add([{ id: auto, x: 1, y: 1, width: 1, height: 1 }], null)).toThrow(/duplicate/);
  });

  it('drops unplaceable regions but still returns their id (warns once)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = new RegionStore();
    const ids = s.add(
      [
        { id: 'ok', x: 0, y: 0, width: 1, height: 1 },
        { id: 'sky', ra: 1, dec: 1, widthArcsec: 1, heightArcsec: 1 }, // no WCS -> dropped
      ],
      null,
    );
    expect(ids).toEqual(['ok', 'sky']);
    expect(s.count).toBe(1);
    expect(s.get('sky')).toBeUndefined();
    // A later update/remove on the dropped id is a no-op.
    expect(s.update('sky', { width: 2 }, null)).toBeNull();
    expect(s.remove('sky')).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('update flags style-only vs geometry vs shape change', () => {
    const s = new RegionStore();
    s.add([{ id: 'a', x: 0, y: 0, width: 2, height: 2 }], null);
    const styleOnly = s.update('a', { stroke: '#f00' }, null);
    expect(styleOnly).toMatchObject({ index: 0, geometryChanged: false, shapeChanged: false });
    const geo = s.update('a', { width: 4 }, null);
    expect(geo).toMatchObject({ geometryChanged: true, shapeChanged: false });
    const flip = s.update('a', { shape: 'polygon', worldVertices: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 2 }] }, null);
    expect(flip).toMatchObject({ geometryChanged: true, shapeChanged: true });
    expect(s.get('a')?.shape).toBe('polygon');
  });

  it('tracks the max bound-radius across add/remove', () => {
    const s = new RegionStore();
    s.add([{ id: 'small', x: 0, y: 0, width: 2, height: 2 }], null); // r = √2
    s.add([{ id: 'big', x: 0, y: 0, width: 20, height: 0 }], null); // r = 10
    expect(s.maxBoundRadius).toBeCloseTo(10, 9);
    s.remove('big');
    expect(s.maxBoundRadius).toBeCloseTo(Math.hypot(1, 1), 9);
    s.clear();
    expect(s.maxBoundRadius).toBe(0);
  });

  it('resolves style: defaults, fill/stroke/dash/strokeWidth', () => {
    const s = new RegionStore();
    s.add([{ id: 'd', x: 0, y: 0, width: 1, height: 1 }], null); // defaults
    const def = s.get('d') as ResolvedRect;
    expect(def.stroke).toEqual(DEFAULT_REGION_STROKE);
    expect(def.fill).toEqual(DEFAULT_REGION_FILL);
    expect(def.strokeWidth).toBe(DEFAULT_REGION_STROKE_WIDTH);
    expect(def.dashOn).toBe(0);

    s.add([{ id: 's', x: 0, y: 0, width: 1, height: 1, fill: '#0000ff80', stroke: 'red', strokeWidth: 3, dash: [6, 4] }], null);
    const styled = s.get('s') as ResolvedRect;
    expect(styled.fill[2]).toBeCloseTo(1, 9);
    expect(styled.fill[3]).toBeCloseTo(128 / 255, 6);
    expect(styled.stroke).toEqual([1, 0, 0, 1]);
    expect(styled.strokeWidth).toBe(3);
    expect(styled.dashOn).toBe(6);
    expect(styled.dashOff).toBe(4);
  });

  it('a world-geometry patch supersedes a sky-origin region (and vice versa)', () => {
    const wcs = wcsByName('axis_aligned');
    const s = new RegionStore();
    s.add([{ id: 'a', ra: 150, dec: 2.2, widthArcsec: 60, heightArcsec: 60 }], wcs);
    const skyCenter = (s.get('a') as ResolvedRect).centerX;

    // Patch to a world-pixel position: without clearing the stale ra/dec the sky
    // branch would win and this patch would be silently ignored.
    const res = s.update('a', { x: 10, y: 20, width: 4, height: 2 }, wcs);
    expect(res).not.toBeNull();
    const world = s.get('a') as ResolvedRect;
    expect(world.centerX).toBe(10.5);
    expect(world.centerY).toBe(20.5);
    expect(world.halfW).toBe(2);
    expect(world.halfH).toBe(1);
    expect(world.centerX).not.toBe(skyCenter);

    // And back: a sky patch supersedes the now-world region.
    s.update('a', { ra: 150, dec: 2.2, widthArcsec: 60, heightArcsec: 60 }, wcs);
    const back = s.get('a') as ResolvedRect;
    expect(back.centerX).toBeCloseTo(skyToPix(wcs, 150, 2.2).x, 6);
  });

  it('a size-only patch stays in the region’s current coordinate family', () => {
    const wcs = wcsByName('axis_aligned');
    const s = new RegionStore();
    s.add([{ id: 'a', ra: 150, dec: 2.2, widthArcsec: 60, heightArcsec: 60 }], wcs);
    const halfW0 = (s.get('a') as ResolvedRect).halfW;
    // widthArcsec is the sky-family size field; the rect stays a sky rect, moves
    // nowhere, and doubling widthArcsec doubles the world half-width.
    const res = s.update('a', { widthArcsec: 120 }, wcs);
    expect(res).not.toBeNull();
    const r = s.get('a') as ResolvedRect;
    expect(r.centerX).toBeCloseTo(skyToPix(wcs, 150, 2.2).x, 6);
    expect(r.halfW).toBeCloseTo(halfW0 * 2, 6);
  });
});
