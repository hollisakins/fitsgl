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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('<FitsExplorer>', () => {
  it('renders the control panel and status bar without WebGL', async () => {
    const { container, getByText } = render(<FitsExplorer bands={BANDS} title="COSMOS-Web" />);
    await waitFor(() => expect(container.querySelector('[data-testid="viewer"]')).not.toBeNull());
    expect(getByText('Display')).toBeTruthy();
    expect(getByText('FITSGL')).toBeTruthy();
    expect(getByText('COSMOS-Web')).toBeTruthy();
    // Single-band default: the band <select> is shown.
    expect(container.querySelector('select')).not.toBeNull();
  });

  it('sets the stretch mode imperatively once the viewer is ready', async () => {
    render(<FitsExplorer bands={BANDS} defaultView={{ mode: 'single', stretch: 'asinh' }} />);
    await waitFor(() => expect(h.core.setStretchMode).toHaveBeenCalledWith('asinh'));
  });

  it('greys cross-grid bands in the RGB picker once a channel is set', async () => {
    const { container } = render(
      <FitsExplorer bands={BANDS} defaultView={{ mode: 'rgb', r: 'f444w', g: 'f277w', b: 'f150w' }} />,
    );
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
    await waitFor(() => expect(container.querySelector('.fgl-grid')).not.toBeNull());
    expect(getByText('My Dataset')).toBeTruthy(); // title from config.dataset.title
    expect(button(container, 'R = subaru_r').disabled).toBe(true); // cross-grid greyed
    expect(button(container, 'R = f150w').disabled).toBe(false);
  });

  it('toggles between single and RGB layer modes', async () => {
    const { container } = render(<FitsExplorer bands={BANDS} />);
    await waitFor(() => expect(container.querySelector('select')).not.toBeNull());
    const rgbBtn = Array.from(container.querySelectorAll('.fgl-seg button')).find(
      (b) => b.textContent === 'RGB',
    ) as HTMLButtonElement;
    act(() => {
      fireEvent.click(rgbBtn);
    });
    await waitFor(() => expect(container.querySelector('.fgl-grid')).not.toBeNull());
    expect(rgbBtn.getAttribute('aria-pressed')).toBe('true');
  });
});
