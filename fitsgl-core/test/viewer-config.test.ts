import { describe, it, expect } from 'vitest';
import type { TilePyramid } from '../src/fpack/tile-source.js';
import {
  validateViewerConfig,
  renderSourceForView,
  type BandConfig,
  type ViewerConfig,
} from '../src/viewer-config.js';

const band = (name: string, tiles: string[] = [`${name}.json`]): BandConfig => ({ name, tiles });

// renderSourceForView only stores the handle, never calls into it.
const fakePyramid = (id: string): TilePyramid => ({ id }) as unknown as TilePyramid;

describe('validateViewerConfig', () => {
  it('accepts a minimal single-band config', () => {
    const cfg: ViewerConfig = { bands: [band('a')], view: { mode: 'single', band: 'a' } };
    expect(() => validateViewerConfig(cfg)).not.toThrow();
  });

  it('accepts an rgb config referencing three bands', () => {
    const cfg: ViewerConfig = {
      bands: [band('r'), band('g'), band('b')],
      view: { mode: 'rgb', r: 'r', g: 'g', b: 'b' },
    };
    expect(() => validateViewerConfig(cfg)).not.toThrow();
  });

  it('rejects empty bands', () => {
    expect(() =>
      validateViewerConfig({ bands: [], view: { mode: 'single', band: 'a' } }),
    ).toThrow(/non-empty array/);
  });

  it('rejects duplicate band names', () => {
    const cfg: ViewerConfig = { bands: [band('a'), band('a')], view: { mode: 'single', band: 'a' } };
    expect(() => validateViewerConfig(cfg)).toThrow(/duplicate band name "a"/);
  });

  it('rejects an empty tiles list', () => {
    const cfg: ViewerConfig = { bands: [band('a', [])], view: { mode: 'single', band: 'a' } };
    expect(() => validateViewerConfig(cfg)).toThrow(/non-empty "tiles"/);
  });

  it('rejects a multi-tile band as an M6 feature', () => {
    const cfg: ViewerConfig = {
      bands: [band('a', ['a0.json', 'a1.json'])],
      view: { mode: 'single', band: 'a' },
    };
    expect(() => validateViewerConfig(cfg)).toThrow(/M6 feature/);
  });

  it('rejects a single view referencing an unknown band', () => {
    const cfg: ViewerConfig = { bands: [band('a')], view: { mode: 'single', band: 'z' } };
    expect(() => validateViewerConfig(cfg)).toThrow(/view\.band references unknown band "z"/);
  });

  it('rejects an rgb view with an unknown channel band', () => {
    const cfg: ViewerConfig = {
      bands: [band('r'), band('g')],
      view: { mode: 'rgb', r: 'r', g: 'g', b: 'missing' },
    };
    expect(() => validateViewerConfig(cfg)).toThrow(/view\.b references unknown band "missing"/);
  });

  it('rejects an empty-string tile URL', () => {
    const cfg: ViewerConfig = { bands: [band('a', [''])], view: { mode: 'single', band: 'a' } };
    expect(() => validateViewerConfig(cfg)).toThrow(/non-string\/empty tile URL/);
  });

  it('rejects stretch.channels on a single-band view', () => {
    const cfg: ViewerConfig = {
      bands: [band('a')],
      view: { mode: 'single', band: 'a' },
      stretch: { channels: { r: { min: 0, max: 1 } } },
    };
    expect(() => validateViewerConfig(cfg)).toThrow(/single-band view cannot use stretch\.channels/);
  });

  it('rejects stretch.range on an rgb view', () => {
    const cfg: ViewerConfig = {
      bands: [band('r'), band('g'), band('b')],
      view: { mode: 'rgb', r: 'r', g: 'g', b: 'b' },
      stretch: { range: { min: 0, max: 1 } },
    };
    expect(() => validateViewerConfig(cfg)).toThrow(/rgb view cannot use stretch\.range/);
  });

  it('rejects a non-finite stretch range', () => {
    const cfg: ViewerConfig = {
      bands: [band('a')],
      view: { mode: 'single', band: 'a' },
      stretch: { range: { min: Number.NaN, max: 1 } },
    };
    expect(() => validateViewerConfig(cfg)).toThrow(/must be finite/);
  });

  it('rejects a collapsed stretch range (max <= min)', () => {
    const cfg: ViewerConfig = {
      bands: [band('a')],
      view: { mode: 'single', band: 'a' },
      stretch: { range: { min: 5, max: 5 } },
    };
    expect(() => validateViewerConfig(cfg)).toThrow(/requires max > min/);
  });

  it('rejects an unknown stretch mode', () => {
    const cfg = {
      bands: [band('a')],
      view: { mode: 'single', band: 'a' },
      stretch: { mode: 'bogus' },
    } as unknown as ViewerConfig;
    expect(() => validateViewerConfig(cfg)).toThrow(/not a known stretch mode/);
  });

  it('rejects an unknown colormap on a single view', () => {
    const cfg = {
      bands: [band('a')],
      view: { mode: 'single', band: 'a', colormap: 'not-a-colormap' },
    } as unknown as ViewerConfig;
    expect(() => validateViewerConfig(cfg)).toThrow(/not a known colormap/);
  });
});

describe('renderSourceForView', () => {
  it('builds a single-band source', () => {
    const pyrs = new Map([['a', fakePyramid('a')]]);
    const src = renderSourceForView({ mode: 'single', band: 'a' }, pyrs);
    expect(src.kind).toBe('single');
    if (src.kind === 'single') expect(src.pyramid).toBe(pyrs.get('a'));
  });

  it('builds an rgb source in r,g,b order', () => {
    const pyrs = new Map([
      ['x', fakePyramid('x')],
      ['y', fakePyramid('y')],
      ['z', fakePyramid('z')],
    ]);
    const src = renderSourceForView({ mode: 'rgb', r: 'x', g: 'y', b: 'z' }, pyrs);
    expect(src.kind).toBe('rgb');
    if (src.kind === 'rgb') {
      expect(src.r).toBe(pyrs.get('x'));
      expect(src.g).toBe(pyrs.get('y'));
      expect(src.b).toBe(pyrs.get('z'));
    }
  });

  it('throws when a referenced band was not loaded', () => {
    const pyrs = new Map<string, TilePyramid>();
    expect(() => renderSourceForView({ mode: 'single', band: 'a' }, pyrs)).toThrow(
      /no loaded pyramid for band "a"/,
    );
  });
});
