import { describe, it, expect } from 'vitest';
import type { TilePyramid, TilePyramidOptions } from '../src/fpack/tile-source.js';
import type { DecodeExecutor } from '../src/fpack/decode-executor.js';
import { FpackFile } from '../src/fpack/fpack-file.js';
import {
  validateViewerConfig,
  renderSourceForView,
  loadViewerSource,
  type BandConfig,
  type ViewerConfig,
} from '../src/viewer-config.js';
import { manifestFetch, fixtureRangeFetcher, createInProcessWorker } from './helpers.js';

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

  it('accepts a weighted multiband view', () => {
    const cfg: ViewerConfig = {
      bands: [band('a'), band('b'), band('c')],
      view: {
        mode: 'multiband',
        bands: [
          { band: 'a', weight: [1, 0, 0] },
          { band: 'b', weight: [0, 1, 0] },
          { band: 'c', weight: [0, 0, 1] },
        ],
      },
    };
    expect(() => validateViewerConfig(cfg)).not.toThrow();
  });

  it('rejects a multiband view referencing an unknown band', () => {
    const cfg: ViewerConfig = {
      bands: [band('a')],
      view: { mode: 'multiband', bands: [{ band: 'z', weight: [1, 1, 1] }] },
    };
    expect(() => validateViewerConfig(cfg)).toThrow(/references unknown band "z"/);
  });

  it('rejects a multiband band with a malformed weight', () => {
    const cfg = {
      bands: [band('a')],
      view: { mode: 'multiband', bands: [{ band: 'a', weight: [1, 0] }] },
    } as unknown as ViewerConfig;
    expect(() => validateViewerConfig(cfg)).toThrow(/weight must be 3 finite numbers/);
  });

  it('rejects an empty multiband view', () => {
    const cfg: ViewerConfig = {
      bands: [band('a')],
      view: { mode: 'multiband', bands: [] },
    };
    expect(() => validateViewerConfig(cfg)).toThrow(/non-empty "bands" list/);
  });

  it('rejects range/channels on a multiband view (trilogy derives levels from stats)', () => {
    const cfg: ViewerConfig = {
      bands: [band('a')],
      view: { mode: 'multiband', bands: [{ band: 'a', weight: [1, 1, 1] }] },
      stretch: { channels: { r: { min: 0, max: 1 } } },
    };
    expect(() => validateViewerConfig(cfg)).toThrow(/no range\/channels/);
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

  it('builds a multiband source in band order with weights', () => {
    const pyrs = new Map([
      ['x', fakePyramid('x')],
      ['y', fakePyramid('y')],
    ]);
    const src = renderSourceForView(
      {
        mode: 'multiband',
        bands: [
          { band: 'x', weight: [1, 0, 0] },
          { band: 'y', weight: [0, 0.5, 1] },
        ],
      },
      pyrs,
    );
    expect(src.kind).toBe('multiband');
    if (src.kind === 'multiband') {
      expect(src.bands.map((b) => b.pyramid)).toEqual([pyrs.get('x'), pyrs.get('y')]);
      expect(src.bands.map((b) => b.weight)).toEqual([
        [1, 0, 0],
        [0, 0.5, 1],
      ]);
    }
  });

  it('throws when a referenced band was not loaded', () => {
    const pyrs = new Map<string, TilePyramid>();
    expect(() => renderSourceForView({ mode: 'single', band: 'a' }, pyrs)).toThrow(
      /no loaded pyramid for band "a"/,
    );
  });
});

describe('loadViewerSource — shared decode pool + disk store (F5)', () => {
  // All bands resolve to the same committed fixture manifest (manifestFetch
  // serves it for any URL), so a 3-band config loads three real engines. URLs
  // are absolute because level filenames resolve against the manifest URL.
  const aband = (name: string): BandConfig => ({
    name,
    tiles: [`http://fixtures.test/${name}/manifest.json`],
  });
  const cfg3: ViewerConfig = {
    bands: [aband('r'), aband('g'), aband('b')],
    view: { mode: 'rgb', r: 'r', g: 'g', b: 'b' },
  };

  function sharedOpts(workers: Array<ReturnType<typeof createInProcessWorker>>): TilePyramidOptions {
    return {
      useWorker: true,
      poolSize: 2,
      workerFactory: () => {
        const w = createInProcessWorker();
        workers.push(w);
        return w;
      },
      fetchImpl: manifestFetch(),
      rangeFetch: fixtureRangeFetcher().fetch,
      blobStore: null,
    };
  }

  it('spawns poolSize workers TOTAL (not per band) and decodes every band through them', async () => {
    const workers: Array<ReturnType<typeof createInProcessWorker>> = [];
    const { pyramids } = await loadViewerSource(cfg3, sharedOpts(workers));
    expect(pyramids.size).toBe(3);
    expect(workers.length).toBe(2); // one shared pool — was 3 × 2 before sharing

    const tiles = await Promise.all([...pyramids.values()].map((p) => p.getTile(0, 0, 0)));
    for (const t of tiles) expect(t.length).toBe(256 * 256);
    for (const p of pyramids.values()) p.destroy();
  });

  it('keeps the shared pool alive until the LAST pyramid is destroyed', async () => {
    const workers: Array<ReturnType<typeof createInProcessWorker>> = [];
    const { pyramids } = await loadViewerSource(cfg3, sharedOpts(workers));
    const ps = [...pyramids.values()];

    ps[0].destroy();
    ps[1].destroy();
    expect(workers.some((w) => w.terminated)).toBe(false); // band 3 still decoding
    ps[2].destroy();
    expect(workers.every((w) => w.terminated)).toBe(true); // last owner released it
  });

  it('force-closes the shared pool when any band fails to load', async () => {
    const workers: Array<ReturnType<typeof createInProcessWorker>> = [];
    const good = manifestFetch();
    const fetchImpl = (async (url: unknown) =>
      String(url).includes('bad')
        ? new Response('missing', { status: 404 })
        : good(url as never)) as typeof fetch;
    const cfg: ViewerConfig = {
      bands: [aband('a'), aband('bad')],
      view: { mode: 'single', band: 'a' },
    };
    await expect(
      loadViewerSource(cfg, { ...sharedOpts(workers), fetchImpl }),
    ).rejects.toThrow(/manifest fetch failed|404/i);
    expect(workers.length).toBe(2); // the pool was built before the loads
    expect(workers.every((w) => w.terminated)).toBe(true); // and torn down on failure
  });

  it('an explicitly injected decoder passes through to every band untouched', async () => {
    let decodes = 0;
    let closes = 0;
    const inline: DecodeExecutor = {
      decode: (bytes, params) => {
        decodes++;
        return FpackFile.decodeTile(bytes, params);
      },
      close: () => {
        closes++;
      },
    };
    const { pyramids } = await loadViewerSource(cfg3, {
      decoder: inline,
      fetchImpl: manifestFetch(),
      rangeFetch: fixtureRangeFetcher().fetch,
      blobStore: null,
    });
    await Promise.all([...pyramids.values()].map((p) => p.getTile(0, 0, 0)));
    expect(decodes).toBe(3);
    for (const p of pyramids.values()) p.destroy();
    // Host-owned executor: each engine closes what it was handed (pre-existing
    // single-owner semantics) — the host's no-op close absorbs it.
    expect(closes).toBe(3);
  });
});
