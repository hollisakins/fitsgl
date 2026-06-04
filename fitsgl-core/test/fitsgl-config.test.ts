import { describe, it, expect } from 'vitest';
import {
  FITSGL_SCHEMA_VERSION,
  fitsglConfigFromDataset,
  loadFitsglConfig,
  resolveFitsglConfig,
  validateFitsglConfig,
} from '../src/fitsgl-config.js';
import type { DatasetBand, DatasetManifest } from '../src/index.js';

/** A structurally valid raw config (override pieces per test). */
function raw(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    dataset: {
      name: 'cosmos',
      title: 'COSMOS-Web',
      bands: [
        { name: 'a', tiles: ['a/manifest.json'], grid: { group: 0, pixelScaleArcsec: 0.03 } },
        { name: 'b', tiles: ['b/manifest.json'], grid: { group: 0 } },
        { name: 'c', tiles: ['c/manifest.json'], grid: { group: 1 } },
      ],
      catalog: { url: 'catalog.csv' },
    },
    defaultView: { mode: 'rgb', r: 'a', g: 'b', b: 'c', stretch: { mode: 'asinh' }, northUp: true },
  };
}

describe('validateFitsglConfig', () => {
  it('accepts a valid config and normalizes it', () => {
    const c = validateFitsglConfig(raw());
    expect(c.schemaVersion).toBe(FITSGL_SCHEMA_VERSION);
    expect(c.dataset.title).toBe('COSMOS-Web');
    expect(c.dataset.bands.map((b) => b.name)).toEqual(['a', 'b', 'c']);
    expect(c.dataset.bands[0].grid).toEqual({ group: 0, pixelScaleArcsec: 0.03 });
    expect(c.dataset.catalog).toEqual({ url: 'catalog.csv' });
    expect(c.defaultView).toEqual({ mode: 'rgb', r: 'a', g: 'b', b: 'c', stretch: { mode: 'asinh' }, northUp: true });
  });

  it('accepts a minimal single-band config (no band/colormap/catalog/title)', () => {
    const c = validateFitsglConfig({
      schemaVersion: 1,
      dataset: { name: 'x', bands: [{ name: 'img', tiles: ['m.json'], grid: { group: 0 } }] },
      defaultView: { mode: 'single' },
    });
    expect(c.defaultView).toEqual({ mode: 'single' });
    expect(c.dataset.catalog).toBeUndefined();
  });

  it('rejects a missing or unknown schemaVersion', () => {
    const { schemaVersion: _omit, ...noVer } = raw();
    expect(() => validateFitsglConfig(noVer)).toThrow(/schemaVersion/);
    expect(() => validateFitsglConfig({ ...raw(), schemaVersion: 2 })).toThrow(/unsupported schemaVersion 2/);
  });

  it('rejects empty bands and duplicate band names', () => {
    expect(() => validateFitsglConfig({ ...raw(), dataset: { name: 'x', bands: [] } })).toThrow(/non-empty array/);
    const dup = raw();
    (dup.dataset as { bands: unknown[] }).bands = [
      { name: 'a', tiles: ['a.json'], grid: { group: 0 } },
      { name: 'a', tiles: ['a2.json'], grid: { group: 0 } },
    ];
    dup.defaultView = { mode: 'single', band: 'a' };
    expect(() => validateFitsglConfig(dup)).toThrow(/duplicate band name "a"/);
  });

  it('rejects a multi-tile band (M6) and a band missing/!int grid.group', () => {
    const m6 = raw();
    (m6.dataset as { bands: unknown[] }).bands = [{ name: 'a', tiles: ['a.json', 'a2.json'], grid: { group: 0 } }];
    m6.defaultView = { mode: 'single', band: 'a' };
    expect(() => validateFitsglConfig(m6)).toThrow(/M6/);

    const noGrid = raw();
    (noGrid.dataset as { bands: unknown[] }).bands = [{ name: 'a', tiles: ['a.json'] }];
    noGrid.defaultView = { mode: 'single', band: 'a' };
    expect(() => validateFitsglConfig(noGrid)).toThrow(/grid/);

    const badGroup = raw();
    (badGroup.dataset as { bands: unknown[] }).bands = [{ name: 'a', tiles: ['a.json'], grid: { group: 1.5 } }];
    badGroup.defaultView = { mode: 'single', band: 'a' };
    expect(() => validateFitsglConfig(badGroup)).toThrow(/grid.group must be an integer/);
  });

  it('rejects default-view references that do not resolve', () => {
    expect(() => validateFitsglConfig({ ...raw(), defaultView: { mode: 'rgb', r: 'a', g: 'b', b: 'nope' } })).toThrow(
      /defaultView.b references unknown band "nope"/,
    );
    expect(() => validateFitsglConfig({ ...raw(), defaultView: { mode: 'single', band: 'zzz' } })).toThrow(
      /references unknown band "zzz"/,
    );
  });

  it('rejects an unknown colormap or stretch mode', () => {
    expect(() =>
      validateFitsglConfig({ ...raw(), defaultView: { mode: 'single', band: 'a', colormap: 'rainbow6000' } }),
    ).toThrow(/not a known colormap/);
    expect(() =>
      validateFitsglConfig({ ...raw(), defaultView: { mode: 'single', band: 'a', stretch: { mode: 'sqrt' } } }),
    ).toThrow(/not a known stretch mode/);
  });

  it('accepts and preserves a band stats histogram', () => {
    const r = raw();
    (r.dataset as { bands: Record<string, unknown>[] }).bands[0].stats = {
      histogram: { counts: [1, 2, 3, 0], lo: 0.5, hi: 9.5 },
    };
    const c = validateFitsglConfig(r);
    expect(c.dataset.bands[0].stats).toEqual({ histogram: { counts: [1, 2, 3, 0], lo: 0.5, hi: 9.5 } });
    expect(c.dataset.bands[1].stats).toBeUndefined(); // omitted ⇒ undefined (viewer scans live)
  });

  it('rejects a malformed band stats histogram', () => {
    const bad = (h: unknown): Record<string, unknown> => {
      const r = raw();
      (r.dataset as { bands: Record<string, unknown>[] }).bands[0].stats = { histogram: h };
      return r;
    };
    expect(() => validateFitsglConfig(bad({ counts: [], lo: 0, hi: 1 }))).toThrow(/counts/);
    expect(() => validateFitsglConfig(bad({ counts: ['x'], lo: 0, hi: 1 }))).toThrow(/counts/);
    expect(() => validateFitsglConfig(bad({ counts: [1, 2], lo: 1, hi: 1 }))).toThrow(/hi > lo/);
  });
});

describe('resolveFitsglConfig', () => {
  it('resolves relative tile + catalog URLs against the config URL', () => {
    const c = resolveFitsglConfig(validateFitsglConfig(raw()), 'https://cdn.example/sets/cosmos/fitsgl.json');
    expect(c.dataset.bands[0].tiles[0]).toBe('https://cdn.example/sets/cosmos/a/manifest.json');
    expect(c.dataset.catalog?.url).toBe('https://cdn.example/sets/cosmos/catalog.csv');
  });
  it('leaves already-absolute URLs unchanged', () => {
    const abs = raw();
    (abs.dataset as { bands: unknown[] }).bands = [
      { name: 'a', tiles: ['https://other.host/a.json'], grid: { group: 0 } },
    ];
    abs.defaultView = { mode: 'single', band: 'a' };
    const c = resolveFitsglConfig(validateFitsglConfig(abs), 'https://cdn.example/x/fitsgl.json');
    expect(c.dataset.bands[0].tiles[0]).toBe('https://other.host/a.json');
  });
  it('preserves band stats through URL resolution', () => {
    const r = raw();
    (r.dataset as { bands: Record<string, unknown>[] }).bands[0].stats = {
      histogram: { counts: [1, 2], lo: 0, hi: 1 },
    };
    const c = resolveFitsglConfig(validateFitsglConfig(r), 'https://cdn.example/sets/cosmos/fitsgl.json');
    expect(c.dataset.bands[0].stats).toEqual({ histogram: { counts: [1, 2], lo: 0, hi: 1 } });
  });
});

describe('loadFitsglConfig', () => {
  function mockFetch(body: unknown, ok = true): typeof fetch {
    return (async () =>
      ({ ok, status: ok ? 200 : 404, statusText: ok ? 'OK' : 'Not Found', json: async () => body }) as Response) as unknown as typeof fetch;
  }

  it('fetches, validates, and resolves URLs against the fetch URL', async () => {
    const c = await loadFitsglConfig('https://cdn.example/sets/cosmos/fitsgl.json', mockFetch(raw()));
    expect(c.dataset.bands[1].tiles[0]).toBe('https://cdn.example/sets/cosmos/b/manifest.json');
    expect(c.dataset.catalog?.url).toBe('https://cdn.example/sets/cosmos/catalog.csv');
  });

  it('throws on a non-ok response', async () => {
    await expect(loadFitsglConfig('https://cdn.example/missing.json', mockFetch(null, false))).rejects.toThrow(/404/);
  });
});

// ---- bridge from a legacy dataset.json -------------------------------------

const dband = (name: string, crval0: number): DatasetBand => ({
  name,
  path: `${name}/manifest.json`,
  ctype1: 'RA---TAN',
  ctype2: 'DEC--TAN',
  shape: [100, 100],
  crpix: [50, 50],
  crval: [crval0, 2],
  cd: [-0.0001, 0, 0, 0.0001],
  pixel_scale_arcsec: 0.36,
  grid_hash: 'x',
});

describe('fitsglConfigFromDataset', () => {
  const DATASET: DatasetManifest = {
    version: 1,
    bands: [dband('a', 150), dband('b', 150), dband('c', 200)], // a,b co-gridded; c 50° away
    default_rgb: { r: 'a', g: 'b', b: 'c' },
  };

  it('assigns grid groups via gridsMatch, resolves URLs, and maps default_rgb', () => {
    const c = fitsglConfigFromDataset(DATASET, 'https://cdn/set/dataset.json');
    expect(c.schemaVersion).toBe(FITSGL_SCHEMA_VERSION);
    expect(c.dataset.bands.map((b) => b.grid.group)).toEqual([0, 0, 1]);
    expect(c.dataset.bands[0].tiles[0]).toBe('https://cdn/set/a/manifest.json');
    expect(c.dataset.bands[0].grid.pixelScaleArcsec).toBe(0.36);
    expect(c.defaultView).toEqual({ mode: 'rgb', r: 'a', g: 'b', b: 'c' });
    // The bridge output must itself validate.
    expect(() => validateFitsglConfig(JSON.parse(JSON.stringify(c)))).not.toThrow();
  });

  it('falls back to single mode when there is no default_rgb', () => {
    const c = fitsglConfigFromDataset({ ...DATASET, default_rgb: null }, 'https://cdn/set/dataset.json');
    expect(c.defaultView).toEqual({ mode: 'single', band: 'a' });
  });
});
