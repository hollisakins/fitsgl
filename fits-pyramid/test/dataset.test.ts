import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  validateDataset,
  loadDataset,
  resolveDatasetBandUrl,
  bandGridSpec,
  compatibleBands,
  DATASET_VERSION,
  type DatasetManifest,
  type DatasetBand,
} from '../src/dataset.js';
import { parseWcs } from '../src/wcs/tan.js';
import { gridsMatch } from '../src/wcs/grid-match.js';

const FIX_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixtureJson: unknown = JSON.parse(readFileSync(join(FIX_DIR, 'dataset_fixture.json'), 'utf8'));

/** A fetch stub returning a fixed JSON body. */
function fakeFetch(body: unknown, ok = true, status = 200): typeof fetch {
  return (async () => ({
    ok,
    status,
    statusText: ok ? 'OK' : 'Not Found',
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe('validateDataset — the Python-written fixture (writer/loader parity)', () => {
  it('validates the dataset.json the pyramid_gen writer emits', () => {
    const ds = validateDataset(fixtureJson);
    expect(ds.version).toBe(DATASET_VERSION);
    expect(ds.bands.map((b) => b.name)).toEqual(['red', 'green', 'blue']);
    expect(ds.default_rgb).toEqual({ r: 'red', g: 'green', b: 'blue' });
    const red = ds.bands[0];
    expect(red.path).toBe('red/manifest.json');
    expect(red.shape).toEqual([512, 512]);
    expect(red.cd).toHaveLength(4);
    expect(typeof red.grid_hash).toBe('string');
  });
});

describe('validateDataset — version policy (new schema: required + checked)', () => {
  const base = (): Record<string, unknown> =>
    JSON.parse(JSON.stringify(fixtureJson)) as Record<string, unknown>;

  it('rejects a missing version (signals a foreign file)', () => {
    const raw = base();
    delete raw.version;
    expect(() => validateDataset(raw)).toThrow(/version/i);
  });

  it('rejects an unsupported major version', () => {
    expect(() => validateDataset({ ...base(), version: 2 })).toThrow(/version/i);
    expect(DATASET_VERSION).toBe(1);
  });

  it('rejects a non-integer version', () => {
    expect(() => validateDataset({ ...base(), version: '1' })).toThrow(/version/i);
  });
});

describe('validateDataset — structural checks', () => {
  const base = (): Record<string, unknown> =>
    JSON.parse(JSON.stringify(fixtureJson)) as Record<string, unknown>;

  it('rejects an empty band list', () => {
    expect(() => validateDataset({ ...base(), bands: [] })).toThrow(/bands/i);
  });

  it('rejects a band missing a required field', () => {
    const raw = base();
    const bands = raw.bands as Array<Record<string, unknown>>;
    delete bands[0].cd;
    expect(() => validateDataset(raw)).toThrow(/cd/i);
  });

  it('rejects a default_rgb that references an unknown band', () => {
    const raw = base();
    raw.default_rgb = { r: 'red', g: 'green', b: 'nope' };
    expect(() => validateDataset(raw)).toThrow(/nope/);
  });

  it('accepts an absent default_rgb (null)', () => {
    const raw = base();
    raw.default_rgb = null;
    expect(validateDataset(raw).default_rgb).toBeNull();
  });
});

describe('loadDataset', () => {
  it('fetches + validates via an injected fetch', async () => {
    const ds = await loadDataset('https://example.test/data/dataset.json', fakeFetch(fixtureJson));
    expect(ds.bands).toHaveLength(3);
  });

  it('throws on a non-ok response', async () => {
    await expect(
      loadDataset('https://example.test/missing.json', fakeFetch(null, false, 404)),
    ).rejects.toThrow(/404|fetch failed/i);
  });
});

describe('resolveDatasetBandUrl', () => {
  it('resolves a relative band path against the dataset URL (WHATWG URL)', () => {
    expect(resolveDatasetBandUrl('https://h.test/data/dataset.json', 'red/manifest.json')).toBe(
      'https://h.test/data/red/manifest.json',
    );
  });
});

describe('bandGridSpec / compatibleBands', () => {
  const ds = validateDataset(fixtureJson) as DatasetManifest;

  it('reconstructs a parseable WCS from the dataset entry (no manifest fetch needed)', () => {
    const spec = bandGridSpec(ds.bands[0]);
    expect(parseWcs(spec.wcs)).not.toBeNull();
    expect(spec.shape).toEqual([512, 512]);
  });

  it('a band is grid-compatible with itself and with its same-grid siblings', () => {
    expect(gridsMatch(bandGridSpec(ds.bands[0]), bandGridSpec(ds.bands[1]))).toBe(true);
    expect(compatibleBands(ds.bands[0], ds.bands).map((b) => b.name)).toEqual([
      'red',
      'green',
      'blue',
    ]);
  });

  it('rejects an incompatible band via the dataset-reconstruction path', () => {
    // The discriminating power of bandGridSpec (the picker grouping without a
    // per-band manifest fetch): a half-pixel CRPIX offset and an off-by-one shape
    // must each be rejected through the reconstructed CD-form WCS.
    const offset: DatasetBand = { ...ds.bands[0], name: 'offset', crpix: [257.0, 256.5] };
    const reshaped: DatasetBand = { ...ds.bands[0], name: 'reshaped', shape: [512, 511] };
    expect(gridsMatch(bandGridSpec(ds.bands[0]), bandGridSpec(offset))).toBe(false);
    expect(gridsMatch(bandGridSpec(ds.bands[0]), bandGridSpec(reshaped))).toBe(false);
    // ...and a picker built from the reference excludes both.
    expect(compatibleBands(ds.bands[0], [...ds.bands, offset, reshaped]).map((b) => b.name)).toEqual([
      'red',
      'green',
      'blue',
    ]);
  });
});
