import { describe, it, expect } from 'vitest';
import {
  activeBandNames,
  bandForRole,
  bandRailModel,
  canComposite,
  clampInspectorWidth,
  defaultExplorerState,
  defaultLayoutState,
  defaultViewFromConfig,
  defaultViewFromDataset,
  deriveViewerConfig,
  explorerBandsFromConfig,
  explorerBandsFromDataset,
  gridGroupOf,
  hasZscalePreset,
  isBandSelectableForRgb,
  isTrilogyComposite,
  parseLayoutState,
  rainbowAction,
  rgbActiveGroup,
  serializeLayoutState,
  INSPECTOR_MAX_WIDTH,
  INSPECTOR_MIN_WIDTH,
  trilogyComposite,
  type ExplorerBand,
  type ExplorerState,
} from '../../src/react/explorer-state.js';
import type { DatasetBand, DatasetManifest, FitsglConfig } from '../../src/index.js';

const band = (name: string, gridGroup = 0): ExplorerBand => ({
  name,
  tiles: [`/${name}/manifest.json`],
  gridGroup,
});

// f090/f150/f277/f444 on one grid (group 0); subaru on another (group 1).
const BANDS: ExplorerBand[] = [
  band('f090w', 0),
  band('f150w', 0),
  band('f277w', 0),
  band('f444w', 0),
  band('subaru_r', 1),
];

describe('gridGroupOf', () => {
  it('defaults to group 0 when unset', () => {
    expect(gridGroupOf({ name: 'x', tiles: ['/x'] })).toBe(0);
    expect(gridGroupOf(band('y', 2))).toBe(2);
  });
});

describe('rgbActiveGroup', () => {
  it('is the group of the first assigned channel', () => {
    expect(rgbActiveGroup(BANDS, { r: 'f444w', g: 'f277w', b: 'f150w' })).toBe(0);
    expect(rgbActiveGroup(BANDS, { r: 'subaru_r', g: 'subaru_r', b: 'subaru_r' })).toBe(1);
  });
  it('is null when no channel resolves to a known band', () => {
    expect(rgbActiveGroup(BANDS, { r: 'nope', g: 'nope', b: 'nope' })).toBeNull();
  });
});

describe('isBandSelectableForRgb (the greying rule)', () => {
  it('greys cross-grid bands once a channel is chosen', () => {
    const rgb = { r: 'f444w', g: 'f277w', b: 'f150w' }; // active group 0
    expect(isBandSelectableForRgb(band('f090w', 0), BANDS, rgb)).toBe(true);
    expect(isBandSelectableForRgb(band('subaru_r', 1), BANDS, rgb)).toBe(false);
  });
  it('allows any band when nothing resolves yet', () => {
    const rgb = { r: '', g: '', b: '' };
    expect(isBandSelectableForRgb(band('subaru_r', 1), BANDS, rgb)).toBe(true);
    expect(isBandSelectableForRgb(band('f444w', 0), BANDS, rgb)).toBe(true);
  });
});

describe('defaultExplorerState', () => {
  it('defaults to single mode on the first band with sensible fields', () => {
    const s = defaultExplorerState(BANDS);
    expect(s.mode).toBe('single');
    expect(s.band).toBe('f090w');
    expect(s.stretch).toBe('asinh');
    expect(s.colormap).toBe('gray');
    expect(s.northUp).toBe(true);
    expect(s.overlay).toBe(false);
  });
  it('builds a valid RGB triple within the largest co-gridded group', () => {
    const s = defaultExplorerState(BANDS);
    const groups = [s.rgb.r, s.rgb.g, s.rgb.b].map((n) => BANDS.find((b) => b.name === n)?.gridGroup);
    expect(groups).toEqual([0, 0, 0]); // never mixes subaru (group 1) in
  });
  it('honors the producer default view', () => {
    const s = defaultExplorerState(BANDS, {
      mode: 'rgb',
      r: 'f444w',
      g: 'f277w',
      b: 'f150w',
      stretch: 'log',
      northUp: false,
    });
    expect(s.mode).toBe('rgb');
    expect(s.rgb).toEqual({ r: 'f444w', g: 'f277w', b: 'f150w' });
    expect(s.stretch).toBe('log');
    expect(s.northUp).toBe(false);
  });
  it('seeds trilogy knobs from the producer default, keeping unset defaults', () => {
    const s = defaultExplorerState(BANDS, {
      mode: 'rgb',
      stretch: 'trilogy',
      trilogy: { noiselum: 0.12, satpercent: 0.01 },
    });
    expect(s.trilogyParams).toEqual({ noiselum: 0.12, satpercent: 0.01, noisesig: 1, noisesig0: 2 });
    // no producer knobs ⇒ library defaults
    expect(defaultExplorerState(BANDS).trilogyParams).toEqual({
      noiselum: 0.15, satpercent: 0.001, noisesig: 1, noisesig0: 2,
    });
  });
  it('pads a triple when the largest group has fewer than three bands', () => {
    const s = defaultExplorerState([band('only', 0)]);
    expect(s.rgb).toEqual({ r: 'only', g: 'only', b: 'only' });
  });
  it('throws on an empty inventory', () => {
    expect(() => defaultExplorerState([])).toThrow(/at least one band/);
  });
});

describe('deriveViewerConfig', () => {
  it('single mode omits colormap for gray, includes it otherwise', () => {
    const s = defaultExplorerState(BANDS);
    const gray = deriveViewerConfig(BANDS, s);
    expect(gray.view).toEqual({ mode: 'single', band: 'f090w' });
    expect(gray.stretch).toEqual({ mode: 'asinh' });
    expect(gray.northUp).toBe(true);

    const colored = deriveViewerConfig(BANDS, { ...s, colormap: 'viridis' });
    expect(colored.view).toEqual({ mode: 'single', band: 'f090w', colormap: 'viridis' });
  });
  it('rgb mode carries the channel assignment', () => {
    const s = { ...defaultExplorerState(BANDS), mode: 'rgb' as const, rgb: { r: 'f444w', g: 'f277w', b: 'f150w' } };
    const cfg = deriveViewerConfig(BANDS, s);
    expect(cfg.view).toEqual({ mode: 'rgb', r: 'f444w', g: 'f277w', b: 'f150w' });
  });
  it('never emits stretch ranges (the explorer drives limits imperatively)', () => {
    const cfg = deriveViewerConfig(BANDS, defaultExplorerState(BANDS));
    expect(cfg.stretch).toEqual({ mode: 'asinh' });
    expect('range' in (cfg.stretch ?? {})).toBe(false);
  });
});

describe('activeBandNames / bandForRole', () => {
  it('lists the displayed band(s)', () => {
    const single = defaultExplorerState(BANDS);
    expect(activeBandNames(single)).toEqual(['f090w']);
    const rgb = { ...single, mode: 'rgb' as const, rgb: { r: 'f444w', g: 'f277w', b: 'f150w' } };
    expect(activeBandNames(rgb)).toEqual(['f444w', 'f277w', 'f150w']);
    expect(bandForRole(rgb, 'g')).toBe('f277w');
  });

  it('lists the weighted composite bands in trilogy mode', () => {
    const s: ExplorerState = {
      ...defaultExplorerState(BANDS),
      mode: 'rgb',
      stretch: 'trilogy',
      weightBands: ['f090w', 'f277w'],
      weights: { f090w: [0, 0, 1], f277w: [1, 0, 0] },
    };
    expect(activeBandNames(s)).toEqual(['f090w', 'f277w']);
  });
});

describe('trilogy weighted composite (faithful)', () => {
  const base = (): ExplorerState => ({
    ...defaultExplorerState(BANDS),
    mode: 'rgb',
    stretch: 'trilogy',
    rgb: { r: 'f444w', g: 'f277w', b: 'f150w' },
  });

  it('isTrilogyComposite is true only for RGB + trilogy', () => {
    expect(isTrilogyComposite(base())).toBe(true);
    expect(isTrilogyComposite({ ...base(), stretch: 'log' })).toBe(false);
    expect(isTrilogyComposite({ ...base(), mode: 'single' })).toBe(false);
  });

  it('falls back to the rgb triple on pure per-channel weights when none are set', () => {
    expect(trilogyComposite(base())).toEqual([
      { band: 'f444w', weight: [1, 0, 0] },
      { band: 'f277w', weight: [0, 1, 0] },
      { band: 'f150w', weight: [0, 0, 1] },
    ]);
  });

  it('merges a repeated triple band by summing its weights (no duplicate manager)', () => {
    const s = { ...base(), rgb: { r: 'f150w', g: 'f150w', b: 'f090w' } };
    expect(trilogyComposite(s)).toEqual([
      { band: 'f150w', weight: [1, 1, 0] },
      { band: 'f090w', weight: [0, 0, 1] },
    ]);
  });

  it('deriveViewerConfig emits a multiband view from the weights', () => {
    const s: ExplorerState = {
      ...base(),
      weightBands: ['f090w', 'f277w'],
      weights: { f090w: [0, 0, 1], f277w: [1, 0, 0] },
    };
    const cfg = deriveViewerConfig(BANDS, s);
    expect(cfg.view).toEqual({
      mode: 'multiband',
      bands: [
        { band: 'f090w', weight: [0, 0, 1] },
        { band: 'f277w', weight: [1, 0, 0] },
      ],
    });
  });

  it('deriveViewerConfig keeps the strict rgb view for non-trilogy curves', () => {
    const cfg = deriveViewerConfig(BANDS, { ...base(), stretch: 'asinh' });
    expect(cfg.view).toEqual({ mode: 'rgb', r: 'f444w', g: 'f277w', b: 'f150w' });
  });
});

describe('rainbowAction', () => {
  const WB: ExplorerBand[] = [
    { name: 'f444w', tiles: ['/x'], gridGroup: 0, wavelengthMicron: 4.4 },
    { name: 'f090w', tiles: ['/x'], gridGroup: 0, wavelengthMicron: 0.9 },
    { name: 'f277w', tiles: ['/x'], gridGroup: 0, wavelengthMicron: 2.77 },
    { name: 'subaru', tiles: ['/x'], gridGroup: 1, wavelengthMicron: 0.6 },
  ];

  it('orders the active group by wavelength (blue→red) and tints the ends', () => {
    const { weightBands, weights } = rainbowAction(WB, 0);
    expect(weightBands).toEqual(['f090w', 'f277w', 'f444w']); // group 0, wavelength-sorted
    expect(weights['f090w'][2]).toBeGreaterThan(weights['f090w'][0]); // bluest → blue-dominant
    expect(weights['f444w'][0]).toBeGreaterThan(weights['f444w'][2]); // reddest → red-dominant
  });

  it('falls back to declaration order when wavelengths are absent', () => {
    const { weightBands } = rainbowAction(BANDS, 0);
    expect(weightBands).toEqual(['f090w', 'f150w', 'f277w', 'f444w']);
  });
});

// ---- dataset-manifest ingestion (real gridsMatch grouping) ------------------

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

const DATASET: DatasetManifest = {
  version: 1,
  bands: [dband('a', 150), dband('b', 150), dband('c', 200)], // a,b co-gridded; c 50° away
  default_rgb: { r: 'a', g: 'b', b: 'c' },
};

describe('explorerBandsFromConfig', () => {
  it('maps label, grid group, pixel scale, and the pre-computed histogram', () => {
    const config: FitsglConfig = {
      schemaVersion: 1,
      dataset: {
        name: 'set',
        bands: [
          {
            name: 'a',
            tiles: ['a/manifest.json'],
            grid: { group: 2, pixelScaleArcsec: 0.06 },
            label: 'Band A',
            pivotUm: 1.501,
            stats: { histogram: { counts: [1, 2, 3], lo: 0.5, hi: 9.5 } },
          },
          { name: 'b', tiles: ['b/manifest.json'], grid: { group: 0 } },
        ],
      },
      defaultView: { mode: 'single', band: 'a' },
    };
    const bands = explorerBandsFromConfig(config);
    expect(bands[0]).toMatchObject({
      name: 'a',
      label: 'Band A',
      gridGroup: 2,
      pixelScaleArcsec: 0.06,
      wavelengthMicron: 1.501,
      histogram: { counts: [1, 2, 3], lo: 0.5, hi: 9.5 },
    });
    expect(bands[1].histogram).toBeUndefined(); // no stats ⇒ no precomputed histogram
    expect(bands[1].wavelengthMicron).toBeUndefined(); // no pivot ⇒ none
  });
});

describe('explorerBandsFromDataset', () => {
  it('assigns grid groups via gridsMatch (co-gridded bands share a group)', () => {
    const bands = explorerBandsFromDataset(DATASET, 'https://cdn/set/dataset.json');
    expect(bands.map((b) => b.gridGroup)).toEqual([0, 0, 1]);
    expect(bands[0].tiles[0]).toBe('https://cdn/set/a/manifest.json');
    expect(bands[0].pixelScaleArcsec).toBe(0.36);
  });
});

describe('defaultViewFromDataset', () => {
  it('maps default_rgb to an rgb default view', () => {
    expect(defaultViewFromDataset(DATASET)).toEqual({ mode: 'rgb', r: 'a', g: 'b', b: 'c' });
  });
  it('falls back to single when there is no default_rgb', () => {
    expect(defaultViewFromDataset({ ...DATASET, default_rgb: null })).toEqual({ mode: 'single' });
  });
});

describe('defaultViewFromConfig', () => {
  it('maps weights and trilogy knobs through from the wire config', () => {
    const config: FitsglConfig = {
      schemaVersion: 1,
      dataset: {
        name: 'set',
        bands: [
          { name: 'a', tiles: ['a/manifest.json'], grid: { group: 0 } },
          { name: 'b', tiles: ['b/manifest.json'], grid: { group: 0 } },
          { name: 'c', tiles: ['c/manifest.json'], grid: { group: 0 } },
        ],
      },
      defaultView: {
        mode: 'rgb',
        r: 'c', g: 'b', b: 'a',
        weights: [
          { band: 'a', weight: [0, 0, 1] },
          { band: 'b', weight: [0, 1, 0] },
          { band: 'c', weight: [1, 0, 0] },
        ],
        stretch: { mode: 'trilogy' },
        trilogy: { noiselum: 0.12 },
      },
    };
    const dv = defaultViewFromConfig(config);
    expect(dv.stretch).toBe('trilogy');
    expect(dv.trilogy).toEqual({ noiselum: 0.12 });
    expect(dv.weights).toHaveLength(3);
    // and the seeded state drives the weighted composite on first paint
    const s = defaultExplorerState(explorerBandsFromConfig(config), dv);
    expect(isTrilogyComposite(s)).toBe(true);
    expect(s.weightBands).toEqual(['a', 'b', 'c']);
    expect(s.trilogyParams.noiselum).toBe(0.12);
  });
});

describe('canComposite', () => {
  it('is true when some grid group has ≥2 bands', () => {
    expect(canComposite(BANDS)).toBe(true); // group 0 has four
  });
  it('is false for a single band', () => {
    expect(canComposite([band('only', 0)])).toBe(false);
  });
  it('is false when every band sits in its own grid group', () => {
    expect(canComposite([band('a', 0), band('b', 1), band('c', 2)])).toBe(false);
  });
});

describe('bandRailModel', () => {
  it('hides the rail for a single-band dataset', () => {
    const one = [band('only', 0)];
    const model = bandRailModel(one, defaultExplorerState(one));
    expect(model.show).toBe(false);
    expect(model.canComposite).toBe(false);
  });

  it('marks the active chip and assigns number-key hints (1–9, then 0)', () => {
    const many = Array.from({ length: 11 }, (_, i) => band(`b${i}`, 0));
    const state: ExplorerState = { ...defaultExplorerState(many), mode: 'single', band: 'b2' };
    const model = bandRailModel(many, state);
    expect(model.show).toBe(true);
    expect(model.channels).toBeNull();
    expect(model.chips[2]).toMatchObject({ name: 'b2', active: true, keyHint: 3 });
    expect(model.chips[0].keyHint).toBe(1);
    expect(model.chips[9].keyHint).toBe(0); // the 10th+ band gets no key hint
    expect(model.chips.filter((c) => c.active)).toHaveLength(1);
  });

  it('exposes the compact R/G/B channel mapping in RGB mode', () => {
    const state: ExplorerState = {
      ...defaultExplorerState(BANDS),
      mode: 'rgb',
      rgb: { r: 'f444w', g: 'f277w', b: 'f150w' },
    };
    const model = bandRailModel(BANDS, state);
    expect(model.chips.every((c) => !c.active)).toBe(true); // single chips inactive in RGB
    expect(model.channels).toEqual([
      { role: 'r', name: 'f444w', label: 'f444w' },
      { role: 'g', name: 'f277w', label: 'f277w' },
      { role: 'b', name: 'f150w', label: 'f150w' },
    ]);
  });
});

describe('hasZscalePreset', () => {
  const withZ: ExplorerBand[] = [
    { name: 'a', tiles: ['/a'], gridGroup: 0, zscale: [1, 9] },
    { name: 'b', tiles: ['/b'], gridGroup: 0 },
  ];
  it('is true when the active single band carries zscale cuts', () => {
    expect(hasZscalePreset(withZ, { ...defaultExplorerState(withZ), mode: 'single', band: 'a' })).toBe(true);
    expect(hasZscalePreset(withZ, { ...defaultExplorerState(withZ), mode: 'single', band: 'b' })).toBe(false);
  });
  it('is true when any RGB channel carries zscale cuts', () => {
    const state: ExplorerState = { ...defaultExplorerState(withZ), mode: 'rgb', rgb: { r: 'b', g: 'b', b: 'a' } };
    expect(hasZscalePreset(withZ, state)).toBe(true);
  });
});

describe('layout state (chrome persistence)', () => {
  it('clamps inspector width to the sane range and rounds', () => {
    expect(clampInspectorWidth(10)).toBe(INSPECTOR_MIN_WIDTH);
    expect(clampInspectorWidth(9999)).toBe(INSPECTOR_MAX_WIDTH);
    expect(clampInspectorWidth(300.6)).toBe(301);
    expect(clampInspectorWidth(Number.NaN)).toBeGreaterThanOrEqual(INSPECTOR_MIN_WIDTH);
  });

  it('round-trips through serialize/parse', () => {
    const s = { ...defaultLayoutState(), width: 410, shelved: true, collapsed: { display: true, composite: false, view: true, 'display.fine': false } };
    expect(parseLayoutState(serializeLayoutState(s))).toEqual(s);
  });

  it('falls back to defaults for null / malformed / partial input', () => {
    const d = defaultLayoutState();
    expect(parseLayoutState(null)).toEqual(d);
    expect(parseLayoutState('not json')).toEqual(d);
    expect(parseLayoutState('123')).toEqual(d);
    // partial: width applied + clamped, unknown collapsed keys ignored, known merged
    const partial = parseLayoutState(JSON.stringify({ width: 5000, collapsed: { view: false, bogus: true } }));
    expect(partial.width).toBe(INSPECTOR_MAX_WIDTH);
    expect(partial.shelved).toBe(d.shelved);
    expect(partial.collapsed.view).toBe(false);
    expect(partial.collapsed).not.toHaveProperty('bogus');
  });
});
