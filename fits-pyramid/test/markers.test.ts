import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  MarkerStore,
  parseColor,
  isMarkerShape,
  resolveMarkerWorld,
  SHAPE_IDS,
  DEFAULT_MARKER_COLOR,
  DEFAULT_MARKER_SHAPE,
  DEFAULT_MARKER_SIZE,
  DEFAULT_MARKER_EDGE,
  type ColorTuple,
} from '../src/overlay/markers.js';
import { parseWcs, skyToPix, type TanWcs } from '../src/wcs/tan.js';

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

describe('parseColor', () => {
  it('parses #rgb / #rrggbb / #rrggbbaa', () => {
    expect(parseColor('#f00')).toEqual([1, 0, 0, 1]);
    expect(parseColor('#ff0000')).toEqual([1, 0, 0, 1]);
    const c = parseColor('#80ffff80') as ColorTuple;
    expect(c).not.toBeNull();
    expect(c[0]).toBeCloseTo(128 / 255, 9);
    expect(c[3]).toBeCloseTo(128 / 255, 9);
  });
  it('parses named colours (case-insensitive) and tuples', () => {
    expect(parseColor('red')).toEqual([1, 0, 0, 1]);
    expect(parseColor('CYAN')).toEqual([0, 1, 1, 1]);
    expect(parseColor('grey')).toEqual([0.5, 0.5, 0.5, 1]);
    expect(parseColor([0.2, 0.4, 0.6])).toEqual([0.2, 0.4, 0.6, 1]);
    expect(parseColor([0.1, 0.2, 0.3, 0.5])).toEqual([0.1, 0.2, 0.3, 0.5]);
  });
  it('clamps out-of-range tuple components', () => {
    expect(parseColor([2, -1, 0.5, 9])).toEqual([1, 0, 0.5, 1]);
  });
  it('returns null for unparseable input', () => {
    expect(parseColor('#zz')).toBeNull();
    expect(parseColor('mauve')).toBeNull();
    expect(parseColor('#12345')).toBeNull(); // wrong length
    expect(parseColor([0, 1] as unknown as [number, number, number])).toBeNull();
  });
});

describe('isMarkerShape', () => {
  it('accepts the three v1 shapes and rejects others', () => {
    for (const s of ['point', 'circle', 'box']) expect(isMarkerShape(s)).toBe(true);
    expect(isMarkerShape('star')).toBe(false);
    expect(isMarkerShape('')).toBe(false);
  });
});

describe('resolveMarkerWorld — precedence matrix + half-pixel convention', () => {
  const { wcs } = wcsByName('axis_aligned');

  it('drops a sky-only marker when there is no WCS', () => {
    expect(resolveMarkerWorld({ ra: 150, dec: 2.2 }, null)).toBeNull();
  });
  it('keeps a pixel-only marker with no WCS (world = x + 0.5)', () => {
    expect(resolveMarkerWorld({ x: 100, y: 50 }, null)).toEqual({ x: 100.5, y: 50.5, ra: null, dec: null });
  });
  it('uses the pixel path for a both-coords marker when there is no WCS', () => {
    const r = resolveMarkerWorld({ ra: 1, dec: 2, x: 10, y: 20 }, null);
    expect(r).toEqual({ x: 10.5, y: 20.5, ra: null, dec: null });
  });
  it('sky wins over pixel when a WCS is present', () => {
    const sample = wcsByName('axis_aligned').cfg.p2w[6];
    const r = resolveMarkerWorld({ ra: sample.ra, dec: sample.dec, x: 0, y: 0 }, wcs);
    expect(r).not.toBeNull();
    const p = skyToPix(wcs, sample.ra, sample.dec);
    expect((r as { x: number }).x).toBeCloseTo(p.x, 9);
    expect((r as { y: number }).y).toBeCloseTo(p.y, 9);
    expect((r as { x: number }).x).not.toBeCloseTo(0.5, 3);
  });
  it('a {x,y} marker lands at the same world point as the {ra,dec} of that source', () => {
    // The catalog x/y are astropy 0-based; world = x + 0.5. skyToPix(ra,dec) of
    // the same source must agree to sub-1e-6 px — the two CSV paths cannot drift.
    for (const cfg of wcsFix.configs) {
      const w = parseWcs(cfg.wcs) as TanWcs;
      for (const s of cfg.p2w) {
        const fromPix = resolveMarkerWorld({ x: s.x0, y: s.y0 }, w);
        const fromSky = resolveMarkerWorld({ ra: s.ra, dec: s.dec }, w);
        expect(fromPix).not.toBeNull();
        expect(fromSky).not.toBeNull();
        expect((fromSky as { x: number }).x).toBeCloseTo((fromPix as { x: number }).x, 6);
        expect((fromSky as { y: number }).y).toBeCloseTo((fromPix as { y: number }).y, 6);
      }
    }
  });
  it('drops markers with non-finite coordinates', () => {
    expect(resolveMarkerWorld({ ra: NaN, dec: 2 }, wcs)).toBeNull();
    expect(resolveMarkerWorld({ x: Infinity, y: 0 }, wcs)).toBeNull();
    expect(resolveMarkerWorld({}, wcs)).toBeNull();
  });
});

describe('MarkerStore', () => {
  it('adds markers, auto-fills ids, and returns ids in input order', () => {
    const store = new MarkerStore();
    const ids = store.add([{ id: 'a', x: 1, y: 1 }, { x: 2, y: 2 }], null);
    expect(ids.length).toBe(2);
    expect(ids[0]).toBe('a');
    expect(typeof ids[1]).toBe('string');
    expect(store.count).toBe(2);
    expect(store.get('a')?.x).toBe(1.5);
    expect(store.list()[1].id).toBe(ids[1]);
  });

  it('applies default style and resolves shape/colour overrides', () => {
    const store = new MarkerStore();
    store.add([{ id: 'd', x: 0, y: 0 }, { id: 'c', x: 1, y: 1, shape: 'box', color: 'red', size: 20, edgeWidth: 3 }], null);
    const d = store.get('d');
    expect(d?.shape).toBe(DEFAULT_MARKER_SHAPE);
    expect(d?.size).toBe(DEFAULT_MARKER_SIZE);
    expect(d?.edgeWidth).toBe(DEFAULT_MARKER_EDGE);
    expect(d?.color).toEqual(DEFAULT_MARKER_COLOR);
    const c = store.get('c');
    expect(c?.shape).toBe('box');
    expect(c?.color).toEqual([1, 0, 0, 1]);
    expect(c?.size).toBe(20);
  });

  it('falls back to default colour on an unparseable colour', () => {
    const store = new MarkerStore();
    store.add([{ id: 'x', x: 0, y: 0, color: 'not-a-color' }], null);
    expect(store.get('x')?.color).toEqual(DEFAULT_MARKER_COLOR);
  });

  it('throws on a duplicate id (within the batch or against existing)', () => {
    const store = new MarkerStore();
    expect(() => store.add([{ id: 'q', x: 0, y: 0 }, { id: 'q', x: 1, y: 1 }], null)).toThrow(/duplicate/);
    store.add([{ id: 'z', x: 0, y: 0 }], null);
    expect(() => store.add([{ id: 'z', x: 1, y: 1 }], null)).toThrow(/duplicate/);
  });

  it('drops unplaceable markers but still returns their id', () => {
    const store = new MarkerStore();
    const ids = store.add([{ id: 'sky', ra: 150, dec: 2 }, { id: 'pix', x: 5, y: 5 }], null);
    expect(ids).toEqual(['sky', 'pix']);
    expect(store.count).toBe(1);
    expect(store.get('sky')).toBeUndefined();
    expect(store.get('pix')).toBeDefined();
    // update/remove on the dropped id are no-ops.
    expect(store.update('sky', { size: 30 }, null)).toBeNull();
    expect(store.remove('sky')).toBe(false);
  });

  it('tracks maxSize (exact on add/remove; upper bound after restyle)', () => {
    const store = new MarkerStore();
    store.add([{ id: 'a', x: 0, y: 0, size: 10 }, { id: 'b', x: 1, y: 1, size: 30 }], null);
    expect(store.maxSize).toBe(30);
    store.update('a', { size: 50 }, null);
    expect(store.maxSize).toBe(50);
    store.remove('a'); // recomputed exactly -> back to b's 30
    expect(store.maxSize).toBe(30);
  });

  it('update: style-only is not a position change; moving x is', () => {
    const store = new MarkerStore();
    store.add([{ id: 'a', x: 0, y: 0 }], null);
    const styled = store.update('a', { color: 'blue' }, null);
    expect(styled).toEqual({ index: 0, positionChanged: false });
    expect(store.get('a')?.color).toEqual([0, 0, 1, 1]);
    const moved = store.update('a', { x: 99 }, null);
    expect(moved?.positionChanged).toBe(true);
    expect(store.get('a')?.x).toBe(99.5);
    expect(store.update('missing', { size: 1 }, null)).toBeNull();
  });

  it('remove re-indexes the remaining markers; replace clears first', () => {
    const store = new MarkerStore();
    store.add([{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 1, y: 1 }, { id: 'c', x: 2, y: 2 }], null);
    expect(store.remove('a')).toBe(true);
    expect(store.remove('a')).toBe(false);
    expect(store.count).toBe(2);
    // b is now index 0, c index 1.
    expect(store.at(0)?.id).toBe('b');
    expect(store.at(1)?.id).toBe('c');
    const ids = store.replace([{ id: 'fresh', x: 9, y: 9 }], null);
    expect(ids).toEqual(['fresh']);
    expect(store.count).toBe(1);
    expect(store.get('b')).toBeUndefined();
  });

  it('resolves a sky marker through the WCS to the fixture pixel', () => {
    const store = new MarkerStore();
    const s = wcsByName('rolled_30').cfg.p2w[12];
    const w = parseWcs(wcsByName('rolled_30').cfg.wcs) as TanWcs;
    store.add([{ id: 's', ra: s.ra, dec: s.dec }], w);
    const m = store.get('s');
    expect(m?.x).toBeCloseTo(s.x0 + 0.5, 6);
    expect(m?.y).toBeCloseTo(s.y0 + 0.5, 6);
    expect(m?.ra).toBeCloseTo(s.ra, 9);
  });

  it('SHAPE_IDS is the frag-shader branch contract', () => {
    expect(SHAPE_IDS).toEqual({ point: 0, circle: 1, box: 2 });
  });
});
