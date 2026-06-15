// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';

/**
 * Conformance guard for the SSG/React tier: render <FitsExplorer> (the one control
 * panel the SSG bundles) with a MAXIMAL FitsglConfig and assert every config key is
 * actually consumed. If a new FitsglConfig key is added but not wired into the
 * panel, this test is where it should be caught.
 *
 * Key -> where it surfaces (asserted below):
 *   dataset.title              -> status-bar field
 *   dataset.bands[].name       -> band identity (select value / RGB aria-labels)
 *   dataset.bands[].label      -> band <select> options + RGB grid heads + status bar
 *   dataset.bands[].grid.group -> RGB cross-grid greying
 *   dataset.bands[].grid.pixelScaleArcsec -> mapped via explorerBandsFromConfig (display TBD)
 *   dataset.bands[].stats.histogram -> pre-seeds the panel histogram (no live scan)
 *   dataset.catalog.url        -> fetched into the overlay
 *   defaultView.mode           -> single <select> vs RGB grid
 *   defaultView.band           -> single-band selection
 *   defaultView.r/g/b          -> RGB channel assignment (status-bar band list)
 *   defaultView.colormap       -> colormap dropdown value
 *   defaultView.stretch.mode   -> imperative setStretchMode
 *   defaultView.northUp        -> North-up toggle state
 *
 * <FitsExplorer> drives the real <FitsViewer> (needs WebGL2, absent in jsdom), so
 * we stub it the same way explorer.test.tsx does.
 */
const h = vi.hoisted(() => {
  const core = {
    setStretch: vi.fn(),
    setChannelStretch: vi.fn(),
    setStretchMode: vi.fn(),
    autoStretch: vi.fn(async () => null),
    visibleHistogram: vi.fn(async () => null),
  };
  const handle = {
    setMarkers: vi.fn(() => [] as string[]),
    addMarkers: vi.fn(() => [] as string[]),
    updateMarker: vi.fn(() => true),
    removeMarker: vi.fn(() => true),
    clearMarkers: vi.fn(),
    setTool: vi.fn(),
    autoStretch: vi.fn(async () => null),
    fitToImage: vi.fn(),
    setCenter: vi.fn(),
    setZoom: vi.fn(),
    getViewer: () => core,
    getPyramids: () => null,
  };
  return { core, handle };
});

vi.mock('../../src/react/index.js', async () => {
  const React = await import('react');
  const FitsViewer = React.forwardRef(function FakeViewer(
    props: { children?: React.ReactNode; onReady?: (handle: unknown) => void },
    ref: React.Ref<unknown>,
  ) {
    React.useImperativeHandle(ref, () => h.handle, []);
    React.useEffect(() => {
      props.onReady?.(h.handle);
    }, []);
    return React.createElement('div', { 'data-testid': 'viewer' }, props.children);
  });
  return { FitsViewer };
});

import { FitsExplorer } from '../../src/react/explorer.js';
import { explorerBandsFromConfig } from '../../src/react/explorer-state.js';
import type { FitsglConfig } from '../../src/index.js';

const button = (root: HTMLElement, name: string): HTMLButtonElement =>
  Array.from(root.querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === name) as HTMLButtonElement;

const northUpToggle = (root: HTMLElement): Element =>
  Array.from(root.querySelectorAll('.fgl-tg')).find((e) => e.textContent?.includes('North up')) as Element;

/** A FitsglConfig that exercises every key the contract defines. */
const MAXIMAL_RGB: FitsglConfig = {
  schemaVersion: 1,
  dataset: {
    name: 'conformance',
    title: 'Conformance Field',
    catalog: { url: 'https://example.test/catalog.csv' },
    bands: [
      {
        name: 'jw_a',
        tiles: ['jw_a/manifest.json'],
        grid: { group: 0, pixelScaleArcsec: 0.03 },
        label: 'A150',
        stats: { histogram: { counts: [3, 7, 5, 2], lo: 0, hi: 4 } },
      },
      { name: 'jw_b', tiles: ['jw_b/manifest.json'], grid: { group: 0 }, label: 'B200', stats: { histogram: { counts: [1, 4, 9, 1], lo: 0, hi: 4 } } },
      { name: 'jw_c', tiles: ['jw_c/manifest.json'], grid: { group: 0 }, label: 'C444', stats: { histogram: { counts: [2, 2, 6, 3], lo: 0, hi: 4 } } },
      { name: 'gnd', tiles: ['gnd/manifest.json'], grid: { group: 1 }, label: 'Ground' },
    ],
  },
  defaultView: { mode: 'rgb', r: 'jw_c', g: 'jw_b', b: 'jw_a', stretch: { mode: 'log' }, northUp: false },
};

const MAXIMAL_SINGLE: FitsglConfig = {
  schemaVersion: 1,
  dataset: {
    name: 'conformance',
    title: 'Single Field',
    bands: [
      {
        name: 'jw_b',
        tiles: ['jw_b/manifest.json'],
        grid: { group: 0 },
        label: 'B200',
        stats: { histogram: { counts: [1, 4, 9, 1], lo: 0, hi: 4 } },
      },
    ],
  },
  defaultView: { mode: 'single', band: 'jw_b', colormap: 'viridis', stretch: { mode: 'asinh' }, northUp: true },
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () => 'id,ra,dec\n1,150.0,2.0\n',
  }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('FitsglConfig conformance (every key consumed by <FitsExplorer>)', () => {
  it('consumes every key of a maximal RGB config', async () => {
    const { container, getByText } = render(<FitsExplorer config={MAXIMAL_RGB} />);
    await waitFor(() => expect(container.querySelector('.fgl-grid')).not.toBeNull());

    // title
    expect(getByText('Conformance Field')).toBeTruthy();
    // defaultView.mode = rgb -> the grid renders (not the single <select>)
    expect(container.querySelector('.fgl-grid')).not.toBeNull();
    // defaultView.r/g/b + labels -> status-bar band list shows the three labels in order
    expect(getByText('C444·B200·A150')).toBeTruthy();
    // grid.group -> cross-grid band greyed, co-gridded band selectable
    expect(button(container, 'R = gnd').disabled).toBe(true);
    expect(button(container, 'R = jw_a').disabled).toBe(false);
    // defaultView.stretch.mode -> imperative setStretchMode
    await waitFor(() => expect(h.core.setStretchMode).toHaveBeenCalledWith('log'));
    // defaultView.northUp = false -> North-up toggle NOT on (default would be on)
    expect(northUpToggle(container).className).not.toContain('on');
    // dataset.catalog.url -> fetched
    expect(fetchMock).toHaveBeenCalledWith('https://example.test/catalog.csv');
    // dataset.bands[].stats.histogram -> panel seeded from precomputed; no live-scan placeholder
    expect(container.querySelector('.fgl-dr-scanning')).toBeNull();
    expect(container.querySelector('.fgl-hist')).not.toBeNull();
  });

  it('consumes every key of a maximal single-band config', async () => {
    const { container, getByText } = render(<FitsExplorer config={MAXIMAL_SINGLE} />);
    await waitFor(() => expect(container.querySelector('select')).not.toBeNull());

    // title
    expect(getByText('Single Field')).toBeTruthy();
    // defaultView.mode = single + defaultView.band -> band <select> value
    expect((container.querySelector('select') as HTMLSelectElement).value).toBe('jw_b');
    // defaultView.colormap -> colormap dropdown trigger shows it
    expect(getByText('viridis')).toBeTruthy();
    // defaultView.stretch.mode
    await waitFor(() => expect(h.core.setStretchMode).toHaveBeenCalledWith('asinh'));
    // defaultView.northUp = true -> North-up toggle on
    expect(northUpToggle(container).className).toContain('on');
  });

  it('maps grid.pixelScaleArcsec through to the explorer band (declared; display TBD)', () => {
    const bands = explorerBandsFromConfig(MAXIMAL_RGB);
    expect(bands[0].pixelScaleArcsec).toBe(0.03);
    expect(bands.map((b) => b.gridGroup)).toEqual([0, 0, 0, 1]); // grid.group preserved
    expect(bands.map((b) => b.label)).toEqual(['A150', 'B200', 'C444', 'Ground']); // label preserved
    expect(bands[0].histogram).toEqual({ counts: [3, 7, 5, 2], lo: 0, hi: 4 }); // stats.histogram preserved
    expect(bands[3].histogram).toBeUndefined(); // no stats on the ground band
  });
});
