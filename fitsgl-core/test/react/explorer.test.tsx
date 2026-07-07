// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, act, fireEvent, waitFor } from '@testing-library/react';

/**
 * `<FitsExplorer>` drives the real `<FitsViewer>`, which needs WebGL2 (absent in
 * jsdom). So we mock the React tier's `FitsViewer` with a stub that renders the
 * control-panel children and exposes a fake handle, and assert the panel renders +
 * the grid-aware greying + the imperative stretch wiring. The pure decision logic
 * (grouping, config derivation) is covered in explorer-state.test.ts.
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
import type { ExplorerBand } from '../../src/react/explorer-state.js';
import type { FitsglConfig } from '../../src/index.js';

const BANDS: ExplorerBand[] = [
  { name: 'f150w', tiles: ['/f150w.json'], gridGroup: 0, label: 'F150W' },
  { name: 'f277w', tiles: ['/f277w.json'], gridGroup: 0, label: 'F277W' },
  { name: 'f444w', tiles: ['/f444w.json'], gridGroup: 0, label: 'F444W' },
  { name: 'subaru_r', tiles: ['/subaru.json'], gridGroup: 1, label: 'Subaru r' },
];

const button = (root: HTMLElement, name: string): HTMLButtonElement =>
  Array.from(root.querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === name) as HTMLButtonElement;

/** Click a docked inspector panel's header by title (e.g. expand the collapsed
 *  Composite/View panel — Tier-2 sections that start collapsed). */
const togglePanel = (root: HTMLElement, title: string): void => {
  const head = Array.from(root.querySelectorAll('.fgl-panel-head')).find((h) =>
    h.textContent?.includes(title),
  ) as HTMLElement | undefined;
  if (head !== undefined) fireEvent.click(head);
};

/** The active band chip's label (band rail, single mode). */
const activeChip = (root: HTMLElement): string | null =>
  root.querySelector('.fgl-chip.on')?.textContent?.trim() ?? null;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('<FitsExplorer>', () => {
  it('renders the shell (band rail, tool rail, inspector, status) without WebGL', async () => {
    const { container, getByText } = render(<FitsExplorer bands={BANDS} title="COSMOS-Web" />);
    await waitFor(() => expect(container.querySelector('[data-testid="viewer"]')).not.toBeNull());
    expect(getByText('Display')).toBeTruthy(); // the default-open inspector panel
    expect(getByText('FITSGL')).toBeTruthy();
    expect(getByText('COSMOS-Web')).toBeTruthy();
    // Band identity is the always-on rail now (≥2 bands), with the first band active.
    expect(container.querySelector('.fgl-bandrail')).not.toBeNull();
    expect(activeChip(container)).toContain('F150W');
    expect(container.querySelector('.fgl-toolrail')).not.toBeNull();
    expect(container.querySelector('.fgl-inspector')).not.toBeNull();
  });

  it('sets the stretch mode imperatively once the viewer is ready', async () => {
    render(<FitsExplorer bands={BANDS} defaultView={{ mode: 'single', stretch: 'asinh' }} />);
    await waitFor(() => expect(h.core.setStretchMode).toHaveBeenCalledWith('asinh'));
  });

  it('greys cross-grid bands in the RGB picker once a channel is set', async () => {
    const { container } = render(
      <FitsExplorer bands={BANDS} defaultView={{ mode: 'rgb', r: 'f444w', g: 'f277w', b: 'f150w' }} />,
    );
    await waitFor(() => expect(container.querySelector('[data-testid="viewer"]')).not.toBeNull());
    // The R/G/B assignment lives in the (collapsed) Composite panel now — expand it.
    togglePanel(container, 'Composite');
    await waitFor(() => expect(container.querySelector('.fgl-grid')).not.toBeNull());
    // Active group is 0 (the JWST bands) — Subaru (group 1) must be disabled,
    // a co-gridded JWST band must remain selectable.
    expect(button(container, 'R = subaru_r').disabled).toBe(true);
    expect(button(container, 'G = subaru_r').disabled).toBe(true);
    expect(button(container, 'R = f150w').disabled).toBe(false);
  });

  it('switches a channel within the grid and reflects it in the status bar', async () => {
    const { container, getByText } = render(
      <FitsExplorer bands={BANDS} defaultView={{ mode: 'rgb', r: 'f444w', g: 'f277w', b: 'f150w' }} title="set" />,
    );
    await waitFor(() => expect(container.querySelector('[data-testid="viewer"]')).not.toBeNull());
    togglePanel(container, 'Composite');
    await waitFor(() => expect(container.querySelector('.fgl-grid')).not.toBeNull());
    // Reassign R to f150w; the status-bar band list updates.
    act(() => {
      fireEvent.click(button(container, 'R = f150w'));
    });
    await waitFor(() => expect(getByText('F150W·F277W·F150W')).toBeTruthy());
  });

  it('accepts a turnkey FitsglConfig (bands + default view + title) directly', async () => {
    const config: FitsglConfig = {
      schemaVersion: 1,
      dataset: {
        name: 'set',
        title: 'My Dataset',
        bands: [
          { name: 'f150w', tiles: ['/f150w.json'], grid: { group: 0 } },
          { name: 'f277w', tiles: ['/f277w.json'], grid: { group: 0 } },
          { name: 'f444w', tiles: ['/f444w.json'], grid: { group: 0 } },
          { name: 'subaru_r', tiles: ['/subaru.json'], grid: { group: 1 } },
        ],
      },
      defaultView: { mode: 'rgb', r: 'f444w', g: 'f277w', b: 'f150w' },
    };
    const { container, getByText } = render(<FitsExplorer config={config} />);
    await waitFor(() => expect(container.querySelector('[data-testid="viewer"]')).not.toBeNull());
    expect(getByText('My Dataset')).toBeTruthy(); // title from config.dataset.title
    togglePanel(container, 'Composite');
    await waitFor(() => expect(container.querySelector('.fgl-grid')).not.toBeNull());
    expect(button(container, 'R = subaru_r').disabled).toBe(true); // cross-grid greyed
    expect(button(container, 'R = f150w').disabled).toBe(false);
  });

  it('toggles single↔RGB via the band-rail RGB toggle (and reveals Composite)', async () => {
    const { container } = render(<FitsExplorer bands={BANDS} />);
    await waitFor(() => expect(container.querySelector('.fgl-bandrail')).not.toBeNull());
    const rgbBtn = container.querySelector('.fgl-rgbtoggle') as HTMLButtonElement;
    expect(rgbBtn).not.toBeNull();
    act(() => {
      fireEvent.click(rgbBtn);
    });
    // Entering RGB flips the toggle on and auto-expands the Composite panel.
    await waitFor(() => expect(container.querySelector('.fgl-grid')).not.toBeNull());
    expect(rgbBtn.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('.fgl-chan')).not.toBeNull(); // rail shows channel pills
  });
});
