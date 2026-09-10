import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  resolveTarget,
  targetMarker,
  TARGET_ID,
  DEFAULT_TARGET_COLOR,
  DEFAULT_TARGET_EDGE,
  DEFAULT_TARGET_SIZE,
} from '../src/overlay/target.js';
import { SHAPE_IDS } from '../src/overlay/markers.js';
import { packOne, OFFSET_STYLE } from '../src/overlay/pack.js';
import { parseWcs, type TanWcs } from '../src/wcs/tan.js';

interface WcsConfig {
  name: string;
  wcs: Record<string, unknown>;
  p2w: Array<{ x0: number; y0: number; ra: number; dec: number }>;
}
const FIX_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const wcsFix = JSON.parse(readFileSync(join(FIX_DIR, 'wcs_fixtures.json'), 'utf8')) as {
  configs: WcsConfig[];
};

function wcsByName(name: string): { wcs: TanWcs; cfg: WcsConfig } {
  const cfg = wcsFix.configs.find((c) => c.name === name);
  if (cfg === undefined) throw new Error(`fixture ${name} missing`);
  const wcs = parseWcs(cfg.wcs);
  expect(wcs).not.toBeNull();
  return { wcs: wcs as TanWcs, cfg };
}

const IMAGE = { width: 2048, height: 2048 };

describe('resolveTarget — placement', () => {
  it('resolves a sky position through the WCS to the fixture pixel', () => {
    const { wcs, cfg } = wcsByName('rolled_30');
    const s = cfg.p2w[12];
    const t = resolveTarget({ ra: s.ra, dec: s.dec }, wcs, IMAGE);
    // World coords put a pixel centre at k + 0.5 (the marker convention).
    expect(t?.x).toBeCloseTo(s.x0 + 0.5, 6);
    expect(t?.y).toBeCloseTo(s.y0 + 0.5, 6);
    expect(t?.ra).toBeCloseTo(s.ra, 9);
    expect(t?.dec).toBeCloseTo(s.dec, 9);
  });

  it('resolves a pixel position and back-fills the sky from the WCS', () => {
    const { wcs, cfg } = wcsByName('rolled_30');
    const s = cfg.p2w[5];
    const t = resolveTarget({ x: s.x0, y: s.y0 }, wcs, IMAGE);
    expect(t?.x).toBeCloseTo(s.x0 + 0.5, 12);
    expect(t?.y).toBeCloseTo(s.y0 + 0.5, 12);
    expect(t?.ra).toBeCloseTo(s.ra, 6);
  });

  it('places a pixel target with no WCS (sky unknown)', () => {
    const t = resolveTarget({ x: 10, y: 20 }, null, IMAGE);
    expect(t?.x).toBe(10.5);
    expect(t?.ra).toBeNull();
    expect(t?.dec).toBeNull();
  });

  it('returns null for a sky target with no WCS', () => {
    expect(resolveTarget({ ra: 150, dec: 2 }, null, IMAGE)).toBeNull();
  });

  it('returns null with no usable coordinate at all', () => {
    expect(resolveTarget({}, wcsByName('rolled_30').wcs, IMAGE)).toBeNull();
    expect(resolveTarget({ ra: Number.NaN, dec: 2 }, wcsByName('rolled_30').wcs, IMAGE)).toBeNull();
  });

  it('returns null when the position does not project to a finite pixel', () => {
    // A real parsed WCS never yields this (a gnomonic projection stays finite even
    // at the antipode, and `parseWcs` rejects a singular CD), so poison `cdInv`
    // directly to cover the guard that keeps NaN out of the instance buffer.
    const poisoned: TanWcs = {
      ...wcsByName('rolled_30').wcs,
      cdInv: [Number.POSITIVE_INFINITY, 0, 0, 1],
    };
    expect(resolveTarget({ ra: 150, dec: 2 }, poisoned, IMAGE)).toBeNull();
  });

  it('places the antipode rather than dropping it (TAN stays finite there)', () => {
    // The gnomonic projection maps a position and its antipode to the same plane
    // point, so this is a placed target far off the image, not a failure.
    const { wcs, cfg } = wcsByName('rolled_30');
    const ref = cfg.p2w[0];
    const t = resolveTarget({ ra: (ref.ra + 180) % 360, dec: -ref.dec }, wcs, IMAGE);
    expect(t).not.toBeNull();
    expect(Number.isFinite(t?.x)).toBe(true);
  });
});

describe('resolveTarget — insideImage', () => {
  it('is true within the native bounds and false outside them', () => {
    expect(resolveTarget({ x: 100, y: 100 }, null, IMAGE)?.insideImage).toBe(true);
    expect(resolveTarget({ x: -50, y: 100 }, null, IMAGE)?.insideImage).toBe(false);
    expect(resolveTarget({ x: 100, y: 9000 }, null, IMAGE)?.insideImage).toBe(false);
  });

  it('excludes the upper bounds, matching CursorInfo.insideImage', () => {
    // The world domain is half-open: `[0, W) x [0, H)`. World W is the outer corner
    // of the last pixel, where the viewer's cursor readout and tile-sampling gate
    // (`world.x < nativeW`) find nothing, so a target there must read as outside or
    // the host would suppress its "outside image" hint over unsamplable ground.
    // Reachable from a pixel target: x = W - 0.5 resolves to world W exactly.
    expect(resolveTarget({ x: IMAGE.width - 0.5, y: 100 }, null, IMAGE)?.x).toBe(IMAGE.width);
    expect(resolveTarget({ x: IMAGE.width - 0.5, y: 100 }, null, IMAGE)?.insideImage).toBe(false);
    expect(resolveTarget({ x: 100, y: IMAGE.height - 0.5 }, null, IMAGE)?.insideImage).toBe(false);
    // The lower bound stays inclusive: world 0 is the first pixel's outer corner
    // and samples pixel 0, exactly as the viewer's `world.x >= 0` allows.
    expect(resolveTarget({ x: -0.5, y: 0 }, null, IMAGE)?.insideImage).toBe(true);
    // The last samplable pixel's centre is inside.
    expect(
      resolveTarget({ x: IMAGE.width - 1, y: IMAGE.height - 1 }, null, IMAGE)?.insideImage,
    ).toBe(true);
  });

  it('is false when the image size is unknown — a target off the image is still placed', () => {
    const t = resolveTarget({ x: 100, y: 100 }, null, null);
    expect(t).not.toBeNull();
    expect(t?.insideImage).toBe(false);
  });
});

describe('resolveTarget — style', () => {
  it('defaults size/edge/colour to the reticle defaults', () => {
    const t = resolveTarget({ x: 0, y: 0 }, null, IMAGE);
    expect(t?.size).toBe(DEFAULT_TARGET_SIZE);
    expect(t?.edgeWidth).toBe(DEFAULT_TARGET_EDGE);
    expect(t?.color).toEqual(DEFAULT_TARGET_COLOR);
  });

  it('accepts overrides and falls back on unusable ones', () => {
    const t = resolveTarget({ x: 0, y: 0, size: 40, edgeWidth: 0, color: '#0f0' }, null, IMAGE);
    expect(t?.size).toBe(40);
    expect(t?.edgeWidth).toBe(0);
    expect(t?.color).toEqual([0, 1, 0, 1]);
    const bad = resolveTarget({ x: 0, y: 0, size: -3, edgeWidth: Number.NaN, color: 'nope' }, null, IMAGE);
    expect(bad?.size).toBe(DEFAULT_TARGET_SIZE);
    expect(bad?.edgeWidth).toBe(DEFAULT_TARGET_EDGE);
    expect(bad?.color).toEqual(DEFAULT_TARGET_COLOR);
  });
});

describe('targetMarker — the packing adapter', () => {
  it('carries the cross glyph and the target id, and packs as shape 3', () => {
    const t = resolveTarget({ x: 3, y: 4, size: 28 }, null, IMAGE);
    const m = targetMarker(t as NonNullable<typeof t>);
    expect(m.shape).toBe('cross');
    expect(m.id).toBe(TARGET_ID);
    expect(m.x).toBe(3.5);
    expect(packOne(m)[OFFSET_STYLE + 1]).toBe(SHAPE_IDS.cross);
  });
});
