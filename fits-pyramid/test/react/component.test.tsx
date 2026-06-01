// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { createRef, StrictMode } from 'react';

/**
 * The React tier drives the *real* core `FitsViewer` in the browser, but jsdom
 * has no WebGL2 (the constructor throws on a real canvas). So we mock the public
 * barrel the component consumes and assert the wiring: that the right viewer calls
 * happen at the right time. The pure config-diff logic is covered separately in
 * plan.test.ts; here we verify lifecycle + prop routing + the imperative handle.
 */
const h = vi.hoisted(() => {
  const ctl = { throwOnConstruct: false };
  const instances: FakeViewer[] = [];
  const createdPyramids: Array<Map<string, { destroy: ReturnType<typeof vi.fn> }>> = [];

  class FakeViewer {
    canvas: unknown;
    source: unknown;
    options: { onFrame?: (info: unknown) => void; onCursor?: (info: unknown) => void; northUp?: boolean };
    setStretch = vi.fn();
    setStretchMode = vi.fn();
    setColormap = vi.fn();
    setChannelStretch = vi.fn();
    setSource = vi.fn();
    setNorthUp = vi.fn();
    setMarkers = vi.fn((m: unknown[]) => m.map((_, i) => `id${i}`));
    addMarkers = vi.fn(() => [] as string[]);
    updateMarker = vi.fn(() => true);
    removeMarker = vi.fn(() => true);
    clearMarkers = vi.fn();
    setMarkerHandlers = vi.fn();
    autoStretch = vi.fn(() => Promise.resolve(null));
    fitToImage = vi.fn();
    setCenter = vi.fn();
    setZoom = vi.fn();
    destroy = vi.fn();
    constructor(canvas: unknown, source: unknown, options: FakeViewer['options']) {
      if (ctl.throwOnConstruct) throw new Error('FitsViewer: WebGL2 is not available');
      this.canvas = canvas;
      this.source = source;
      this.options = options;
      instances.push(this);
    }
    fireFrame(info: unknown): void {
      this.options.onFrame?.(info);
    }
  }

  const makePyramids = (): Map<string, { destroy: ReturnType<typeof vi.fn> }> => {
    const map = new Map([['f200w', { destroy: vi.fn(), getManifest: () => ({}) }]]);
    createdPyramids.push(map);
    return map;
  };
  const loadViewerSource = vi.fn(async () => ({ pyramids: makePyramids(), source: { kind: 'single' } }));
  const renderSourceForView = vi.fn((_view: unknown, _pyramids: unknown) => ({ kind: 'single', tag: 'rebuilt' }));

  return { ctl, instances, createdPyramids, FakeViewer, loadViewerSource, renderSourceForView };
});

vi.mock('../../src/index.js', () => ({
  FitsViewer: h.FakeViewer,
  loadViewerSource: h.loadViewerSource,
  renderSourceForView: h.renderSourceForView,
}));

import { FitsViewer } from '../../src/react/index.js';
import type { FitsViewerHandle } from '../../src/react/index.js';
import type { ViewerConfig } from '../../src/index.js';

function single(overrides: Partial<ViewerConfig> = {}): ViewerConfig {
  return {
    bands: [{ name: 'f200w', tiles: ['/f200w/manifest.json'] }],
    view: { mode: 'single', band: 'f200w' },
    ...overrides,
  };
}

/** Three-band config (the r/g/b bands always present) so single↔rgb is in-place. */
function rgbCfg(overrides: Partial<ViewerConfig> = {}): ViewerConfig {
  return {
    bands: [
      { name: 'r', tiles: ['/r.json'] },
      { name: 'g', tiles: ['/g.json'] },
      { name: 'b', tiles: ['/b.json'] },
    ],
    view: { mode: 'rgb', r: 'r', g: 'g', b: 'b' },
    ...overrides,
  };
}

/** A fresh fake pyramid map, recorded so a test can assert exactly-once destroy. */
function freshPyramids(): Map<string, { destroy: ReturnType<typeof vi.fn>; getManifest: () => object }> {
  const map = new Map([
    ['f200w', { destroy: vi.fn(), getManifest: () => ({}) }],
    ['r', { destroy: vi.fn(), getManifest: () => ({}) }],
    ['g', { destroy: vi.fn(), getManifest: () => ({}) }],
    ['b', { destroy: vi.fn(), getManifest: () => ({}) }],
  ]);
  h.createdPyramids.push(map);
  return map;
}

beforeEach(() => {
  h.ctl.throwOnConstruct = false;
  h.instances.length = 0;
  h.createdPyramids.length = 0;
  h.loadViewerSource.mockClear();
  h.renderSourceForView.mockClear();
  h.loadViewerSource.mockImplementation(async () => ({ pyramids: freshPyramids(), source: { kind: 'single' } }));
});

describe('<FitsViewer> lifecycle', () => {
  it('loads the config, constructs the viewer, and fires onReady with a handle', async () => {
    const config = single();
    const onReady = vi.fn();
    render(<FitsViewer config={config} onReady={onReady} tileOptions={{ useWorker: false }} />);

    await waitFor(() => expect(h.instances).toHaveLength(1));
    expect(h.loadViewerSource).toHaveBeenCalledWith(config, { useWorker: false });
    const viewer = h.instances[0];
    // onFrame trampoline always installed (it drives the first-frame auto-stretch).
    expect(typeof viewer.options.onFrame).toBe('function');
    await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
    const handle = onReady.mock.calls[0][0] as FitsViewerHandle;
    expect(typeof handle.setMarkers).toBe('function');
    expect(handle.getViewer()).toBe(viewer);
  });

  it('passes northUp + onCursor into the constructor options', async () => {
    const onCursor = vi.fn();
    render(<FitsViewer config={single({ northUp: false })} onCursor={onCursor} />);
    await waitFor(() => expect(h.instances).toHaveLength(1));
    expect(h.instances[0].options.northUp).toBe(false);
    expect(typeof h.instances[0].options.onCursor).toBe('function');
  });

  it('applies an explicit single-band stretch range immediately at load', async () => {
    render(<FitsViewer config={single({ stretch: { range: { min: 1, max: 9 } } })} />);
    await waitFor(() => expect(h.instances).toHaveLength(1));
    expect(h.instances[0].setStretch).toHaveBeenCalledWith(1, 9);
    expect(h.instances[0].autoStretch).not.toHaveBeenCalled();
  });

  it('defers auto-stretch (omitted stretch) until the first drawn frame', async () => {
    render(<FitsViewer config={single()} />);
    await waitFor(() => expect(h.instances).toHaveLength(1));
    const viewer = h.instances[0];
    expect(viewer.autoStretch).not.toHaveBeenCalled();
    await act(async () => {
      viewer.fireFrame({ frame: 1 });
    });
    expect(viewer.autoStretch).toHaveBeenCalledTimes(1);
    // A second frame must not re-trigger it.
    await act(async () => {
      viewer.fireFrame({ frame: 2 });
    });
    expect(viewer.autoStretch).toHaveBeenCalledTimes(1);
  });

  it('applies the colormap and stretch mode from the initial config', async () => {
    render(
      <FitsViewer
        config={single({ view: { mode: 'single', band: 'f200w', colormap: 'viridis' }, stretch: { mode: 'log', range: { min: 0, max: 1 } } })}
      />,
    );
    await waitFor(() => expect(h.instances).toHaveLength(1));
    expect(h.instances[0].setColormap).toHaveBeenCalledWith('viridis');
    expect(h.instances[0].setStretchMode).toHaveBeenCalledWith('log');
  });

  it('sets inline overlay markers from the config at load', async () => {
    render(<FitsViewer config={single({ overlay: { markers: [{ ra: 1, dec: 2 }] } })} />);
    await waitFor(() => expect(h.instances).toHaveLength(1));
    expect(h.instances[0].setMarkers).toHaveBeenCalledWith([{ ra: 1, dec: 2 }]);
  });
});

describe('<FitsViewer> controlled updates', () => {
  it('re-applies a changed stretch range without reloading', async () => {
    const { rerender } = render(<FitsViewer config={single({ stretch: { range: { min: 0, max: 1 } } })} />);
    await waitFor(() => expect(h.instances).toHaveLength(1));
    const viewer = h.instances[0];
    rerender(<FitsViewer config={single({ stretch: { range: { min: 2, max: 8 } } })} />);
    await waitFor(() => expect(viewer.setStretch).toHaveBeenCalledWith(2, 8));
    expect(h.loadViewerSource).toHaveBeenCalledTimes(1); // no reload
    expect(h.instances).toHaveLength(1); // same viewer
  });

  it('calls setSource (not reload) when the band selection changes', async () => {
    const twoBands = (band: string): ViewerConfig => ({
      bands: [
        { name: 'a', tiles: ['/a.json'] },
        { name: 'b', tiles: ['/b.json'] },
      ],
      view: { mode: 'single', band },
    });
    const { rerender } = render(<FitsViewer config={twoBands('a')} />);
    await waitFor(() => expect(h.instances).toHaveLength(1));
    rerender(<FitsViewer config={twoBands('b')} />);
    await waitFor(() => expect(h.instances[0].setSource).toHaveBeenCalledTimes(1));
    expect(h.renderSourceForView).toHaveBeenCalled();
    expect(h.loadViewerSource).toHaveBeenCalledTimes(1);
  });

  it('calls setNorthUp when the controlled flag changes', async () => {
    const { rerender } = render(<FitsViewer config={single({ northUp: true })} />);
    await waitFor(() => expect(h.instances).toHaveLength(1));
    rerender(<FitsViewer config={single({ northUp: false })} />);
    await waitFor(() => expect(h.instances[0].setNorthUp).toHaveBeenCalledWith(false));
  });

  it('reloads (new viewer) when a band URL changes', async () => {
    const { rerender } = render(<FitsViewer config={single()} />);
    await waitFor(() => expect(h.instances).toHaveLength(1));
    const first = h.instances[0];
    rerender(<FitsViewer config={single({ bands: [{ name: 'f200w', tiles: ['/v2/manifest.json'] }] })} />);
    await waitFor(() => expect(h.instances).toHaveLength(2));
    expect(h.loadViewerSource).toHaveBeenCalledTimes(2);
    // The first viewer is torn down on reload.
    expect(first.destroy).toHaveBeenCalled();
  });
});

describe('<FitsViewer> imperative handle', () => {
  it('proxies marker mutations to the live viewer', async () => {
    const ref = createRef<FitsViewerHandle>();
    render(<FitsViewer config={single()} ref={ref} />);
    await waitFor(() => expect(h.instances).toHaveLength(1));
    const viewer = h.instances[0];
    act(() => {
      ref.current?.setMarkers([{ ra: 1, dec: 2 }]);
      ref.current?.clearMarkers();
    });
    expect(viewer.setMarkers).toHaveBeenCalledWith([{ ra: 1, dec: 2 }]);
    expect(viewer.clearMarkers).toHaveBeenCalled();
  });

  it('no-ops (and returns empty) for marker calls before the viewer is ready', () => {
    const ref = createRef<FitsViewerHandle>();
    // Never resolve the load, so the viewer is never constructed.
    h.loadViewerSource.mockImplementation(() => new Promise(() => {}));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<FitsViewer config={single()} ref={ref} />);
    expect(ref.current?.setMarkers([{ ra: 1, dec: 2 }])).toEqual([]);
    expect(ref.current?.updateMarker('x', {})).toBe(false);
    expect(ref.current?.getViewer()).toBe(null);
    warn.mockRestore();
  });
});

describe('<FitsViewer> teardown + errors', () => {
  it('destroys the viewer and every band pyramid on unmount', async () => {
    const ref = createRef<FitsViewerHandle>();
    const { unmount } = render(<FitsViewer config={single()} ref={ref} />);
    await waitFor(() => expect(h.instances).toHaveLength(1));
    const viewer = h.instances[0];
    const pyramids = ref.current?.getPyramids();
    const pyramid = [...(pyramids?.values() ?? [])][0];
    unmount();
    expect(viewer.destroy).toHaveBeenCalled();
    expect(pyramid.destroy).toHaveBeenCalled();
  });

  it('reports a load failure through onError', async () => {
    h.loadViewerSource.mockImplementationOnce(async () => {
      throw new Error('manifest 404');
    });
    const onError = vi.fn();
    render(<FitsViewer config={single()} onError={onError} />);
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect((onError.mock.calls[0][0] as Error).message).toBe('manifest 404');
    expect(h.instances).toHaveLength(0);
  });

  it('reports a viewer construction failure through onError and frees the pyramids', async () => {
    h.ctl.throwOnConstruct = true;
    const onError = vi.fn();
    render(<FitsViewer config={single()} onError={onError} />);
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect((onError.mock.calls[0][0] as Error).message).toMatch(/WebGL2/);
    // The pyramids loaded before the failed construction must be destroyed.
    const map = h.createdPyramids[h.createdPyramids.length - 1];
    expect([...map.values()][0].destroy).toHaveBeenCalled();
  });

  it('does not double-destroy pyramids when construction throws then unmounts', async () => {
    h.ctl.throwOnConstruct = true;
    const { unmount } = render(<FitsViewer config={single()} onError={vi.fn()} />);
    await waitFor(() => expect(h.createdPyramids).toHaveLength(1));
    const pyramid = [...h.createdPyramids[0].values()][0];
    await waitFor(() => expect(pyramid.destroy).toHaveBeenCalledTimes(1)); // freed on the throw
    unmount();
    expect(pyramid.destroy).toHaveBeenCalledTimes(1); // not freed again by cleanup
  });
});

describe('<FitsViewer> load races + stretch correctness (review regressions)', () => {
  it('applies a controlled field changed while the initial load is in flight', async () => {
    // Hold the load open so a prop change lands in the pending-load window.
    let resolveLoad: () => void = () => {};
    h.loadViewerSource.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveLoad = () => res({ pyramids: freshPyramids(), source: { kind: 'single' } });
        }),
    );
    const { rerender } = render(<FitsViewer config={single({ stretch: { range: { min: 0, max: 1 } } })} />);
    // Change the stretch before the viewer exists; the apply effect can't reconcile yet.
    rerender(<FitsViewer config={single({ stretch: { range: { min: 7, max: 9 } } })} />);
    await act(async () => {
      resolveLoad();
      await Promise.resolve();
    });
    await waitFor(() => expect(h.instances).toHaveLength(1));
    // The viewer must reflect the LATEST prop, not the mount-time snapshot.
    expect(h.instances[0].setStretch).toHaveBeenCalledWith(7, 9);
    expect(h.instances[0].setStretch).not.toHaveBeenCalledWith(0, 1);
  });

  it('builds from the latest view when it changes during the load', async () => {
    let resolveLoad: () => void = () => {};
    h.loadViewerSource.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveLoad = () => res({ pyramids: freshPyramids(), source: { kind: 'single' } });
        }),
    );
    const { rerender } = render(<FitsViewer config={rgbCfg({ view: { mode: 'single', band: 'r' } })} />);
    rerender(<FitsViewer config={rgbCfg({ view: { mode: 'rgb', r: 'r', g: 'g', b: 'b' } })} />);
    await act(async () => {
      resolveLoad();
      await Promise.resolve();
    });
    await waitFor(() => expect(h.instances).toHaveLength(1));
    // renderSourceForView is called with the freshest view to build the source.
    const lastCall = h.renderSourceForView.mock.calls.at(-1);
    expect(lastCall?.[0]).toEqual({ mode: 'rgb', r: 'r', g: 'g', b: 'b' });
  });

  it('auto-stretches the new mode on a live single->rgb switch with omitted stretch', async () => {
    const { rerender } = render(<FitsViewer config={rgbCfg({ view: { mode: 'single', band: 'r' } })} />);
    await waitFor(() => expect(h.instances).toHaveLength(1));
    const viewer = h.instances[0];
    await act(async () => {
      viewer.fireFrame({ frame: 1 }); // a frame has drawn, so the switch stretches immediately
    });
    viewer.autoStretch.mockClear();
    viewer.setSource.mockClear();
    rerender(<FitsViewer config={rgbCfg({ view: { mode: 'rgb', r: 'r', g: 'g', b: 'b' } })} />);
    await waitFor(() => expect(viewer.setSource).toHaveBeenCalledTimes(1));
    expect(viewer.autoStretch).toHaveBeenCalledTimes(1); // setSource + autoStretch, like the demo
  });

  it('survives a StrictMode double-mount with exactly one live viewer and no leak', async () => {
    render(
      <StrictMode>
        <FitsViewer config={single()} />
      </StrictMode>,
    );
    await waitFor(() => expect(h.instances.length).toBeGreaterThanOrEqual(1));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // Exactly one viewer is still alive; any cancelled mount's viewer is destroyed.
    const liveViewers = h.instances.filter((v) => v.destroy.mock.calls.length === 0);
    expect(liveViewers).toHaveLength(1);
    // Exactly one pyramid set is still alive; the cancelled mount's set is freed.
    const liveMaps = h.createdPyramids.filter((m) =>
      [...m.values()].some((p) => p.destroy.mock.calls.length === 0),
    );
    expect(liveMaps).toHaveLength(1);
  });

  it('honours explicit RGB channels and auto-stretches only the omitted one', async () => {
    render(
      <FitsViewer config={rgbCfg({ stretch: { channels: { r: { min: 1, max: 2 }, g: { min: 3, max: 4 } } } })} />,
    );
    await waitFor(() => expect(h.instances).toHaveLength(1));
    const viewer = h.instances[0];
    // The two pinned channels are set immediately; b is omitted.
    expect(viewer.setChannelStretch).toHaveBeenCalledWith('r', 1, 2);
    expect(viewer.setChannelStretch).toHaveBeenCalledWith('g', 3, 4);
    // Auto is deferred until a frame draws (no clobber yet).
    expect(viewer.autoStretch).not.toHaveBeenCalled();
    await act(async () => {
      viewer.fireFrame({ frame: 1 });
      await Promise.resolve();
    });
    expect(viewer.autoStretch).toHaveBeenCalledTimes(1);
    // After auto (which overwrites all three), the pinned channels are re-applied.
    await waitFor(() =>
      expect(viewer.setChannelStretch.mock.calls.filter((c) => c[0] === 'r').length).toBeGreaterThanOrEqual(2),
    );
  });
});
