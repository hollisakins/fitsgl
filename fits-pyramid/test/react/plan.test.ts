import { describe, it, expect } from 'vitest';
import {
  planConfigUpdate,
  bandsSignature,
  viewSignature,
  colormapSignature,
  stretchSignature,
  stretchRangeSignature,
  northUpDependency,
  DEFAULT_STRETCH_MODE,
} from '../../src/react/plan.js';
import type { ViewerConfig } from '../../src/index.js';

/** A minimal single-band config; spread to vary one field at a time. */
function single(overrides: Partial<ViewerConfig> = {}): ViewerConfig {
  return {
    bands: [{ name: 'f200w', tiles: ['/f200w/manifest.json'] }],
    view: { mode: 'single', band: 'f200w' },
    ...overrides,
  };
}

function rgb(overrides: Partial<ViewerConfig> = {}): ViewerConfig {
  return {
    bands: [
      { name: 'r', tiles: ['/r/manifest.json'] },
      { name: 'g', tiles: ['/g/manifest.json'] },
      { name: 'b', tiles: ['/b/manifest.json'] },
    ],
    view: { mode: 'rgb', r: 'r', g: 'g', b: 'b' },
    ...overrides,
  };
}

describe('planConfigUpdate', () => {
  it('treats the first apply (prev === null) as a band reload, nothing else', () => {
    const plan = planConfigUpdate(null, single());
    expect(plan.reloadBands).toBe(true);
    expect(plan.setSource).toBe(false);
    expect(plan.colormap).toBe(false);
    expect(plan.stretchMode).toBe(false);
    expect(plan.stretch).toBe(false);
    expect(plan.northUp).toBe(false);
  });

  it('reports no change for an identical (but freshly-constructed) config', () => {
    const plan = planConfigUpdate(single(), single());
    expect(plan).toEqual({
      reloadBands: false,
      setSource: false,
      colormap: false,
      stretchMode: false,
      stretch: false,
      northUp: false,
    });
  });

  it('flags a reload when a band URL changes, and suppresses the per-field diffs', () => {
    const prev = single();
    const next = single({ bands: [{ name: 'f200w', tiles: ['/f200w/v2/manifest.json'] }] });
    const plan = planConfigUpdate(prev, next);
    expect(plan.reloadBands).toBe(true);
    // Exclusive: the rebuilt viewer re-applies everything, so nothing else fires.
    expect(plan.setSource).toBe(false);
    expect(plan.stretch).toBe(false);
  });

  it('flags a reload when a band name changes', () => {
    const prev = single();
    const next = single({
      bands: [{ name: 'renamed', tiles: ['/f200w/manifest.json'] }],
      view: { mode: 'single', band: 'renamed' },
    });
    expect(planConfigUpdate(prev, next).reloadBands).toBe(true);
  });

  it('flags setSource (only) when the single-band selection changes', () => {
    const prev = single({
      bands: [
        { name: 'a', tiles: ['/a.json'] },
        { name: 'b', tiles: ['/b.json'] },
      ],
      view: { mode: 'single', band: 'a' },
    });
    const next = single({
      bands: [
        { name: 'a', tiles: ['/a.json'] },
        { name: 'b', tiles: ['/b.json'] },
      ],
      view: { mode: 'single', band: 'b' },
    });
    const plan = planConfigUpdate(prev, next);
    expect(plan.reloadBands).toBe(false);
    expect(plan.setSource).toBe(true);
    expect(plan.stretch).toBe(false);
  });

  it('flags setSource when switching single -> rgb (same bands)', () => {
    const bands = [
      { name: 'r', tiles: ['/r.json'] },
      { name: 'g', tiles: ['/g.json'] },
      { name: 'b', tiles: ['/b.json'] },
    ];
    const prev: ViewerConfig = { bands, view: { mode: 'single', band: 'r' } };
    const next: ViewerConfig = { bands, view: { mode: 'rgb', r: 'r', g: 'g', b: 'b' } };
    const plan = planConfigUpdate(prev, next);
    expect(plan.reloadBands).toBe(false);
    expect(plan.setSource).toBe(true);
    // The grayscale colormap of the single view becomes 'none' under rgb -> clear it.
    expect(plan.colormap).toBe(true);
  });

  it('flags colormap (only) when the single-band colormap changes', () => {
    const prev = single({ view: { mode: 'single', band: 'f200w', colormap: 'viridis' } });
    const next = single({ view: { mode: 'single', band: 'f200w', colormap: 'magma' } });
    const plan = planConfigUpdate(prev, next);
    expect(plan.colormap).toBe(true);
    expect(plan.setSource).toBe(false); // same band selection
  });

  it('does not flag colormap when the same band keeps grayscale', () => {
    const plan = planConfigUpdate(single(), single());
    expect(plan.colormap).toBe(false);
  });

  it('flags stretchMode (only) when the transfer curve changes', () => {
    const prev = single({ stretch: { mode: 'linear', range: { min: 0, max: 1 } } });
    const next = single({ stretch: { mode: 'log', range: { min: 0, max: 1 } } });
    const plan = planConfigUpdate(prev, next);
    expect(plan.stretchMode).toBe(true);
    expect(plan.stretch).toBe(false); // the interval is unchanged
  });

  it('treats an omitted mode as the default, so omit<->default is not a change', () => {
    const prev = single({ stretch: { range: { min: 0, max: 1 } } });
    const next = single({ stretch: { mode: DEFAULT_STRETCH_MODE, range: { min: 0, max: 1 } } });
    expect(planConfigUpdate(prev, next).stretchMode).toBe(false);
  });

  it('flags stretch (only) when the interval changes', () => {
    const prev = single({ stretch: { mode: 'linear', range: { min: 0, max: 1 } } });
    const next = single({ stretch: { mode: 'linear', range: { min: 0, max: 5 } } });
    const plan = planConfigUpdate(prev, next);
    expect(plan.stretch).toBe(true);
    expect(plan.stretchMode).toBe(false);
  });

  it('flags stretch when an rgb channel interval changes', () => {
    const prev = rgb({ stretch: { channels: { r: { min: 0, max: 1 } } } });
    const next = rgb({ stretch: { channels: { r: { min: 0, max: 2 } } } });
    expect(planConfigUpdate(prev, next).stretch).toBe(true);
  });

  it('flags northUp only when explicitly set and changed', () => {
    expect(planConfigUpdate(single({ northUp: true }), single({ northUp: false })).northUp).toBe(true);
    // omitted -> uncontrolled: never flagged, even if prev had a value
    expect(planConfigUpdate(single({ northUp: true }), single()).northUp).toBe(false);
    expect(planConfigUpdate(single(), single({ northUp: true })).northUp).toBe(true);
    expect(planConfigUpdate(single({ northUp: false }), single({ northUp: false })).northUp).toBe(false);
  });
});

describe('signature helpers', () => {
  it('bandsSignature is stable across fresh objects and sensitive to urls/names', () => {
    expect(bandsSignature(single())).toBe(bandsSignature(single()));
    expect(bandsSignature(single())).not.toBe(
      bandsSignature(single({ bands: [{ name: 'f200w', tiles: ['/other.json'] }] })),
    );
  });

  it('viewSignature ignores the colormap (that is a separate setter)', () => {
    const a = viewSignature({ mode: 'single', band: 'x' });
    const b = viewSignature({ mode: 'single', band: 'x', colormap: 'viridis' });
    expect(a).toBe(b);
    expect(viewSignature({ mode: 'single', band: 'x' })).not.toBe(
      viewSignature({ mode: 'single', band: 'y' }),
    );
  });

  it('colormapSignature distinguishes gray, named, and rgb (none)', () => {
    expect(colormapSignature({ mode: 'single', band: 'x' })).toBe('gray');
    expect(colormapSignature({ mode: 'single', band: 'x', colormap: 'viridis' })).toBe('name:viridis');
    expect(colormapSignature({ mode: 'rgb', r: 'r', g: 'g', b: 'b' })).toBe('none');
  });

  it('stretchSignature reflects mode + interval; stretchRangeSignature only the interval', () => {
    expect(stretchSignature({ mode: 'log', range: { min: 0, max: 1 } })).not.toBe(
      stretchSignature({ mode: 'linear', range: { min: 0, max: 1 } }),
    );
    expect(stretchRangeSignature({ mode: 'log', range: { min: 0, max: 1 } })).toBe(
      stretchRangeSignature({ mode: 'linear', range: { min: 0, max: 1 } }),
    );
  });

  it('northUpDependency maps omitted -> null, set -> the boolean', () => {
    expect(northUpDependency(single())).toBe(null);
    expect(northUpDependency(single({ northUp: true }))).toBe(true);
    expect(northUpDependency(single({ northUp: false }))).toBe(false);
  });
});
