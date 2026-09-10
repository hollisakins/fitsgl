// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, act, fireEvent, waitFor } from '@testing-library/react';

/**
 * `<FitsExplorer>` drives the real `<FitsViewer>`, which needs WebGL2 (absent in
 * jsdom). So we mock the React tier's `FitsViewer` with a stub that renders the
 * control-panel children and exposes a fake handle, and assert the panel renders +
 * the grid-aware greying + the imperative stretch wiring. The pure decision logic
 * (grouping, config derivation) is covered in explorer-state.test.ts.
 */
const h = vi.hoisted(() => {
  // `getWcs` reads a mutable holder the test file fills with a real
  // astropy-generated fixture WCS after the imports settle (a hoisted factory
  // runs before them), so the go-to path exercises true sky->pixel math.
  const wcsRef: { current: unknown } = { current: null };
  const core = {
    setStretch: vi.fn(),
    setChannelStretch: vi.fn(),
    setStretchMode: vi.fn(),
    autoStretch: vi.fn(async () => null),
    visibleHistogram: vi.fn(async () => null),
    setCenter: vi.fn(),
    setZoom: vi.fn(),
    getWcs: vi.fn(() => wcsRef.current),
    getCameraState: vi.fn(() => ({ centerX: 0, centerY: 0, zoom: 0.5 })),
  };
  const handle = {
    setMarkers: vi.fn(() => [] as string[]),
    addMarkers: vi.fn(() => [] as string[]),
    updateMarker: vi.fn(() => true),
    removeMarker: vi.fn(() => true),
    clearMarkers: vi.fn(),
    setTool: vi.fn(),
    setTarget: vi.fn(),
    getTarget: vi.fn(() => ({ insideImage: true })),
    autoStretch: vi.fn(async () => null),
    fitToImage: vi.fn(),
    setCenter: vi.fn(),
    setZoom: vi.fn(),
    getViewer: () => core,
    getPyramids: () => null,
  };
  return { core, handle, wcsRef };
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

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { FitsExplorer } from '../../src/react/explorer.js';
import type { ExplorerBand } from '../../src/react/explorer-state.js';
import { encodeShareState } from '../../src/react/share-url.js';
import { parseWcs, type FitsglConfig, type TanWcs } from '../../src/index.js';

interface WcsConfig {
  name: string;
  wcs: Record<string, unknown>;
  p2w: Array<{ x0: number; y0: number; ra: number; dec: number }>;
}
const FIX_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const wcsFix = JSON.parse(readFileSync(join(FIX_DIR, 'wcs_fixtures.json'), 'utf8')) as {
  configs: WcsConfig[];
};
const GOTO_FIX = wcsFix.configs.find((c) => c.name === 'rolled_30') as WcsConfig;
const GOTO_WCS = parseWcs(GOTO_FIX.wcs) as TanWcs;
h.wcsRef.current = GOTO_WCS;

const BANDS: ExplorerBand[] = [
  { name: 'f150w', tiles: ['/f150w.json'], gridGroup: 0, label: 'F150W' },
  { name: 'f277w', tiles: ['/f277w.json'], gridGroup: 0, label: 'F277W' },
  { name: 'f444w', tiles: ['/f444w.json'], gridGroup: 0, label: 'F444W' },
  { name: 'subaru_r', tiles: ['/subaru.json'], gridGroup: 1, label: 'Subaru r' },
];

const button = (root: HTMLElement, name: string): HTMLButtonElement =>
  Array.from(root.querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === name) as HTMLButtonElement;

/**
 * Ensure the Composite panel is open and its grid rendered. Idempotent by design:
 * entering RGB mode auto-opens Composite (explorer.tsx `openPanel('composite')`),
 * and that runs on an effect whose timing relative to the test is not fixed. A
 * blind `togglePanel` therefore races — if the auto-open lands first, a toggle
 * *closes* the panel and the grid never appears. This opens only when the header
 * is collapsed (aria-expanded guard, never closes) and waits for the grid.
 */
const openComposite = async (root: HTMLElement): Promise<void> => {
  await waitFor(() => {
    if (root.querySelector('.fgl-grid') === null) {
      const head = Array.from(root.querySelectorAll('.fgl-panel-head')).find((h) =>
        h.textContent?.includes('Composite'),
      ) as HTMLElement | undefined;
      if (head !== undefined && head.getAttribute('aria-expanded') !== 'true') {
        fireEvent.click(head);
      }
    }
    expect(root.querySelector('.fgl-grid')).not.toBeNull();
  });
};

/** The active band chip's label (band rail, single mode). */
const activeChip = (root: HTMLElement): string | null =>
  root.querySelector('.fgl-chip.on')?.textContent?.trim() ?? null;

beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = '';
});

afterEach(() => {
  window.location.hash = '';
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
    await openComposite(container);
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
    await openComposite(container);
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
    await openComposite(container);
    expect(button(container, 'R = subaru_r').disabled).toBe(true); // cross-grid greyed
    expect(button(container, 'R = f150w').disabled).toBe(false);
  });

  describe('go to coordinates', () => {
    const at = GOTO_FIX.p2w[12];
    const coord = `${at.ra} ${at.dec}`;
    const gotoInput = (root: HTMLElement): HTMLInputElement =>
      root.querySelector('.fgl-goto-in') as HTMLInputElement;

    const openBox = async (root: HTMLElement): Promise<HTMLInputElement> => {
      act(() => {
        fireEvent.click(button(root, 'Go to coordinates'));
      });
      await waitFor(() => expect(root.querySelector('.fgl-goto-float')).not.toBeNull());
      return gotoInput(root);
    };

    it('opens the floating box from the tool rail, focused', async () => {
      const { container } = render(<FitsExplorer bands={BANDS} />);
      await waitFor(() => expect(container.querySelector('[data-testid="viewer"]')).not.toBeNull());
      expect(container.querySelector('.fgl-goto-float')).toBeNull(); // closed by default
      const input = await openBox(container);
      expect(document.activeElement).toBe(input);
    });

    it('opens on the G shortcut', async () => {
      const { container } = render(<FitsExplorer bands={BANDS} />);
      await waitFor(() => expect(container.querySelector('[data-testid="viewer"]')).not.toBeNull());
      act(() => {
        fireEvent.keyDown(window, { key: 'g' });
      });
      await waitFor(() => expect(container.querySelector('.fgl-goto-float')).not.toBeNull());
    });

    it('recenters, snaps to native, pins the target, and shows it in the status bar', async () => {
      const { container } = render(<FitsExplorer bands={BANDS} />);
      await waitFor(() => expect(container.querySelector('[data-testid="viewer"]')).not.toBeNull());
      const input = await openBox(container);
      act(() => {
        fireEvent.change(input, { target: { value: coord } });
        fireEvent.keyDown(input, { key: 'Enter' });
      });
      await waitFor(() => expect(h.core.setCenter).toHaveBeenCalled());
      const [cx, cy] = h.core.setCenter.mock.calls[0] as [number, number];
      expect(cx).toBeCloseTo(at.x0 + 0.5, 4);
      expect(cy).toBeCloseTo(at.y0 + 0.5, 4);
      // The fake camera reports zoom 0.5, so the jump snaps up to native 1:1.
      expect(h.core.setZoom).toHaveBeenCalledWith(1);
      await waitFor(() =>
        expect(h.handle.setTarget).toHaveBeenCalledWith(
          expect.objectContaining({ ra: expect.any(Number), dec: expect.any(Number) }),
        ),
      );
      const pinned = h.handle.setTarget.mock.calls.at(-1)?.[0] as { ra: number; dec: number };
      expect(pinned.ra).toBeCloseTo(at.ra, 4);
      expect(pinned.dec).toBeCloseTo(at.dec, 4);
      await waitFor(() => expect(container.textContent).toContain('target'));
    });

    it('flags unreadable input without moving the camera', async () => {
      const { container } = render(<FitsExplorer bands={BANDS} />);
      await waitFor(() => expect(container.querySelector('[data-testid="viewer"]')).not.toBeNull());
      const input = await openBox(container);
      act(() => {
        fireEvent.change(input, { target: { value: 'somewhere nice' } });
        fireEvent.keyDown(input, { key: 'Enter' });
      });
      await waitFor(() => expect(container.querySelector('.fgl-goto-in.err')).not.toBeNull());
      expect(container.querySelector('.fgl-goto-hint.err')?.textContent).toContain('RA/Dec');
      expect(h.core.setCenter).not.toHaveBeenCalled();
    });

    it('clears the pinned target on Escape', async () => {
      const { container } = render(<FitsExplorer bands={BANDS} />);
      await waitFor(() => expect(container.querySelector('[data-testid="viewer"]')).not.toBeNull());
      const input = await openBox(container);
      act(() => {
        fireEvent.change(input, { target: { value: coord } });
        fireEvent.keyDown(input, { key: 'Enter' });
      });
      await waitFor(() => expect(h.handle.setTarget).toHaveBeenCalled());
      act(() => {
        fireEvent.keyDown(window, { key: 'Escape' });
      });
      // The window handler ignores events from form fields, so Escape in the box
      // is handled by the input itself; both paths end with a cleared target.
      await waitFor(() => expect(h.handle.setTarget).toHaveBeenLastCalledWith(null));
      expect(container.querySelector('.fgl-goto-float')).toBeNull();
    });

    it('clears the target on Escape from inside the input', async () => {
      const { container } = render(<FitsExplorer bands={BANDS} />);
      await waitFor(() => expect(container.querySelector('[data-testid="viewer"]')).not.toBeNull());
      const input = await openBox(container);
      act(() => {
        fireEvent.change(input, { target: { value: coord } });
        fireEvent.keyDown(input, { key: 'Enter' });
      });
      await waitFor(() => expect(h.handle.setTarget).toHaveBeenCalled());
      act(() => {
        fireEvent.keyDown(input, { key: 'Escape' });
      });
      await waitFor(() => expect(h.handle.setTarget).toHaveBeenLastCalledWith(null));
      expect(container.querySelector('.fgl-goto-float')).toBeNull();
    });

    it('pins a target carried by a shared view link', async () => {
      window.location.hash = `#v=${encodeShareState({ t: [at.ra, at.dec] })}`;
      const { container } = render(<FitsExplorer bands={BANDS} />);
      await waitFor(() => expect(container.querySelector('[data-testid="viewer"]')).not.toBeNull());
      await waitFor(() =>
        expect(h.handle.setTarget).toHaveBeenCalledWith({ ra: at.ra, dec: at.dec }),
      );
      // A shared target does NOT move the camera on its own (that's the `c` field).
      expect(h.core.setCenter).not.toHaveBeenCalled();
    });
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
