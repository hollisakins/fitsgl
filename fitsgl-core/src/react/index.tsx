/**
 * @fitsgl/core/react — the React delivery tier (M5, decision D12).
 *
 * One `<FitsViewer>` component, a thin **consumer of the frozen public API**
 * (`@fitsgl/core`): it owns a canvas, loads a `ViewerConfig`, drives the core
 * `FitsViewer` through its lifecycle, and tears everything down on unmount. It
 * imports nothing private — building this tier on the public surface is itself a
 * check that D11's API is sufficient.
 *
 * The controlled/imperative boundary (D12):
 *   - CONTROLLED by the `config: ViewerConfig` prop — the single high-level
 *     contract every tier shares. Each change is diffed by the pure
 *     `planConfigUpdate` (./plan) and routed to the cheapest viewer call: a band
 *     change reloads + rebuilds; `view`/`colormap`/`stretch`/`northUp` are live
 *     setters on the existing viewer.
 *   - IMPERATIVE via a `ref` handle for the high-frequency live-data path a host
 *     (e.g. CAMPFIRE) drives: `setMarkers`/`addMarkers`/`updateMarker`/
 *     `removeMarker`/`clearMarkers`, plus `autoStretch`/`fitToImage`/`getViewer`.
 *     Markers are deliberately NOT a controlled prop — a 10–20k-element array prop
 *     would diff on every render; pushing through the ref does not.
 *
 * Callback mutability mirrors the core: `onFrame`/`onCursor` are fixed at viewer
 * construction (the wrapper installs stable trampolines that read the latest prop
 * from a ref, so their *implementations* may change without a rebuild, but adding
 * `onCursor` where there was none takes effect on the next band reload); the three
 * marker handlers hot-swap via `setMarkerHandlers` whenever their presence changes.
 */

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import type { CSSProperties, ReactNode } from 'react';

import { FitsViewer as CoreViewer, loadViewerSource, renderSourceForView } from '../index.js';
import type {
  AutoStretchResult,
  CursorInfo,
  FitsViewerOptions,
  MarkerEvent,
  MarkerHandlers,
  MarkerInput,
  MarkerPatch,
  ResolvedMarker,
  TilePyramid,
  TilePyramidOptions,
  ViewerConfig,
  ViewerFrameInfo,
} from '../index.js';
import {
  bandsSignature,
  colormapSignature,
  northUpDependency,
  planConfigUpdate,
  stretchSignature,
  viewSignature,
  DEFAULT_STRETCH_MODE,
} from './plan.js';

/** Re-export the core viewer's type so a host using only this subpath can name
 *  the `getViewer()` escape hatch's return value. */
export type { FitsViewer as FitsViewerCore } from '../index.js';

/**
 * The imperative handle exposed via `ref` (decision D12). Marker mutation is the
 * live, high-frequency path CAMPFIRE drives; the rest are one-shot actions that
 * have no natural declarative prop. All methods are safe to call before the viewer
 * has loaded — they no-op (and `setMarkers`/`addMarkers`, the likeliest to be
 * misused, warn once) until `onReady` fires.
 */
export interface FitsViewerHandle {
  /** Replace all overlay markers; returns the resolved ids (see core `setMarkers`). */
  setMarkers(markers: MarkerInput[]): string[];
  /** Append markers; returns the resolved ids. */
  addMarkers(markers: MarkerInput[]): string[];
  /** Patch one marker by id; returns whether it existed. */
  updateMarker(id: string, patch: MarkerPatch): boolean;
  /** Remove one marker by id; returns whether it existed. */
  removeMarker(id: string): boolean;
  /** Remove all markers. */
  clearMarkers(): void;
  /** Auto-stretch to the data in view; resolves null before the first frame. */
  autoStretch(pLo?: number, pHi?: number): Promise<AutoStretchResult | null>;
  /** Centre + zoom so the whole mosaic is visible. */
  fitToImage(): void;
  /** Move the world centre. */
  setCenter(x: number, y: number): void;
  /** Set the zoom (drawing-buffer px per native px). */
  setZoom(zoom: number): void;
  /** Escape hatch: the underlying core viewer, or null before load / after unmount. */
  getViewer(): CoreViewer | null;
  /** Escape hatch: every loaded band pyramid by name, or null before load. */
  getPyramids(): ReadonlyMap<string, TilePyramid> | null;
}

export interface FitsViewerProps {
  /** The single high-level contract: bands to load + the initial/controlled view. */
  config: ViewerConfig;
  /** Tile-fetch options (worker, cache size, custom range fetch). Read at load time. */
  tileOptions?: TilePyramidOptions;
  /** GPU texture budget per band (core default 200). Applied at construction. */
  textureBudget?: number;
  /** Select pyramid levels at device-pixel resolution. Applied at construction. */
  hiDpiLevels?: boolean;
  /** Per-frame telemetry (zoom/level/bounds). Fixed at construction (see file note). */
  onFrame?: (info: ViewerFrameInfo) => void;
  /** Cursor world/sky readout; null on leave. Fixed at construction (see file note). */
  onCursor?: (info: CursorInfo | null) => void;
  /** Marker click (non-drag). Hot-swappable. */
  onMarkerClick?: (e: MarkerEvent) => void;
  /** Marker hover change; null on leave. Hot-swappable. */
  onMarkerHover?: (e: MarkerEvent | null) => void;
  /** Built-in popup content for the hovered marker. Hot-swappable. */
  markerTooltip?: (m: ResolvedMarker) => string | HTMLElement | null;
  /** Fired once the viewer is constructed (and again after each band reload). */
  onReady?: (handle: FitsViewerHandle) => void;
  /** Fired if loading or viewer construction fails (e.g. no WebGL2, bad manifest). */
  onError?: (err: unknown) => void;
  /** Class for the container `<div>` (size the viewer by sizing this element). */
  className?: string;
  /** Inline style for the container `<div>` (merged over the defaults). */
  style?: CSSProperties;
  /** Rendered over the canvas (the container is `position: relative`) — HUD/controls. */
  children?: ReactNode;
}

/** Latest callback props, read by the stable viewer trampolines at event time. */
interface CallbackBag {
  onFrame?: (info: ViewerFrameInfo) => void;
  onCursor?: (info: CursorInfo | null) => void;
  onMarkerClick?: (e: MarkerEvent) => void;
  onMarkerHover?: (e: MarkerEvent | null) => void;
  markerTooltip?: (m: ResolvedMarker) => string | HTMLElement | null;
  onReady?: (handle: FitsViewerHandle) => void;
  onError?: (err: unknown) => void;
}

const CONTAINER_STYLE: CSSProperties = { position: 'relative', width: '100%', height: '100%' };
const CANVAS_STYLE: CSSProperties = { display: 'block', width: '100%', height: '100%' };

const FitsViewerComponent = forwardRef<FitsViewerHandle, FitsViewerProps>(function FitsViewer(
  props,
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewerRef = useRef<CoreViewer | null>(null);
  const pyramidsRef = useRef<Map<string, TilePyramid> | null>(null);
  /** The config the live viewer currently reflects — the diff baseline. */
  const appliedRef = useRef<ViewerConfig | null>(null);
  /** Latest props the async load + event trampolines need, refreshed each render. */
  const latestRef = useRef<{
    config: ViewerConfig;
    tileOptions: TilePyramidOptions;
    textureBudget?: number;
    hiDpiLevels?: boolean;
    cb: CallbackBag;
  }>({
    config: props.config,
    tileOptions: props.tileOptions ?? {},
    textureBudget: props.textureBudget,
    hiDpiLevels: props.hiDpiLevels,
    cb: props,
  });
  /** A frame has drawn (autoStretch is a no-op until then). */
  const frameSeenRef = useRef(false);
  /** A stretch action waiting on the first drawn frame (omitted stretch at load),
   *  or null. Holds the full action — auto-stretch plus any explicit-channel
   *  re-apply — so the deferred path matches the immediate path exactly. */
  const pendingStretchRef = useRef<(() => void) | null>(null);

  // Refresh the latest-props ref every render. Written here (not in an effect) so
  // the value is current before any effect or event fires; never read during render.
  latestRef.current = {
    config: props.config,
    tileOptions: props.tileOptions ?? {},
    textureBudget: props.textureBudget,
    hiDpiLevels: props.hiDpiLevels,
    cb: props,
  };

  // Build the marker handlers from the *currently present* callbacks (so the core
  // only does pointer work a host actually wants — `markerNoop` aside) with stable
  // trampolines that read the freshest closure.
  const installMarkerHandlers = (): void => {
    const viewer = viewerRef.current;
    if (viewer === null) return;
    const cb = latestRef.current.cb;
    const handlers: MarkerHandlers = {};
    if (cb.onMarkerClick !== undefined) handlers.onMarkerClick = (e) => latestRef.current.cb.onMarkerClick?.(e);
    if (cb.onMarkerHover !== undefined) handlers.onMarkerHover = (e) => latestRef.current.cb.onMarkerHover?.(e);
    if (cb.markerTooltip !== undefined) handlers.markerTooltip = (m) => latestRef.current.cb.markerTooltip?.(m) ?? null;
    viewer.setMarkerHandlers(handlers);
  };

  // Run an auto-stretch action now if a frame has drawn (autoStretch is a no-op
  // until then), else defer the whole action to the first frame.
  const runOrDeferAuto = (action: () => void): void => {
    if (frameSeenRef.current) action();
    else pendingStretchRef.current = action;
  };

  // Apply a controlled stretch. Explicit interval(s) are set immediately. An
  // omitted single-band range, or any omitted RGB channel, auto-stretches the
  // band(s) in view — and because the core's RGB `autoStretch` overwrites all
  // three channels, any *explicitly pinned* channels are re-applied after it
  // resolves, honouring the config contract's "omit a channel to auto-stretch it".
  const applyControlledStretch = (viewer: CoreViewer, config: ViewerConfig): void => {
    if (config.view.mode === 'multiband') {
      // A weighted multi-band composite is the faithful-trilogy path: per-band
      // levels come from precomputed stats and are applied imperatively by the host
      // (`applyTrilogy`), not from a controlled interval — so there is nothing to
      // auto-stretch here.
      return;
    }
    if (config.view.mode === 'single') {
      const r = config.stretch?.range;
      if (r !== undefined) {
        viewer.setStretch(r.min, r.max);
        return;
      }
      runOrDeferAuto(() => void viewer.autoStretch());
      return;
    }
    // RGB: set every pinned channel now; if all three are pinned, no auto needed.
    const ch = config.stretch?.channels;
    const roles = ['r', 'g', 'b'] as const;
    const pinned = roles.filter((role) => ch?.[role] !== undefined);
    const setPinned = (): void => {
      for (const role of pinned) {
        const r = ch?.[role];
        if (r !== undefined) viewer.setChannelStretch(role, r.min, r.max);
      }
    };
    setPinned();
    if (pinned.length === 3) return;
    // Some channel omitted: auto-stretch all, then restore the pinned channel(s)
    // the auto pass clobbered (autoStretch is async, so re-apply on resolution).
    runOrDeferAuto(() => void viewer.autoStretch().then(setPinned));
  };

  // ---- imperative handle (stable across renders + reloads) -----------------
  const handleRef = useRef<FitsViewerHandle | null>(null);
  if (handleRef.current === null) {
    let warnedNoViewer = false;
    const warnNoViewer = (action: string): void => {
      if (warnedNoViewer) return;
      warnedNoViewer = true;
      console.warn(`<FitsViewer>: ${action} called before the viewer was ready (wait for onReady).`);
    };
    handleRef.current = {
      setMarkers: (m) => {
        const v = viewerRef.current;
        if (v === null) {
          warnNoViewer('setMarkers');
          return [];
        }
        return v.setMarkers(m);
      },
      addMarkers: (m) => {
        const v = viewerRef.current;
        if (v === null) {
          warnNoViewer('addMarkers');
          return [];
        }
        return v.addMarkers(m);
      },
      updateMarker: (id, patch) => viewerRef.current?.updateMarker(id, patch) ?? false,
      removeMarker: (id) => viewerRef.current?.removeMarker(id) ?? false,
      clearMarkers: () => viewerRef.current?.clearMarkers(),
      autoStretch: (pLo, pHi) => viewerRef.current?.autoStretch(pLo, pHi) ?? Promise.resolve(null),
      fitToImage: () => viewerRef.current?.fitToImage(),
      setCenter: (x, y) => viewerRef.current?.setCenter(x, y),
      setZoom: (z) => viewerRef.current?.setZoom(z),
      getViewer: () => viewerRef.current,
      getPyramids: () => pyramidsRef.current,
    };
  }
  useImperativeHandle(ref, () => handleRef.current as FitsViewerHandle, []);

  // ---- load + (re)build the viewer when the band set changes ----------------
  // Keyed on the band signature only: a band-URL change reloads pyramids and
  // rebuilds the viewer; view/stretch/etc. are handled by the apply effect below.
  const bandsKey = bandsSignature(props.config);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    let cancelled = false;
    let localViewer: CoreViewer | null = null;
    let localPyramids: Map<string, TilePyramid> | null = null;

    const destroyLocal = (): void => {
      localViewer?.destroy();
      if (localPyramids !== null) for (const p of localPyramids.values()) p.destroy();
    };

    // The bands cannot change within a single load instance (a band change re-runs
    // this effect and cancels this one), so the effect-time `config` is the right
    // source to LOAD. But the display fields can change while the load is in flight,
    // and the apply effect can't reconcile a viewer that doesn't exist yet — so the
    // post-construction apply + the diff baseline read the FRESHEST committed config
    // (`latest`) at resolution time, closing that window with no extra effect run.
    const { config, tileOptions } = latestRef.current;
    loadViewerSource(config, tileOptions)
      .then(({ pyramids }) => {
        localPyramids = pyramids;
        if (cancelled) {
          for (const p of pyramids.values()) p.destroy();
          localPyramids = null;
          return;
        }
        const latest = latestRef.current.config;
        // A frame must draw before autoStretch works; reset per viewer build.
        frameSeenRef.current = false;
        pendingStretchRef.current = null;

        const onFrameWrapper = (info: ViewerFrameInfo): void => {
          if (!frameSeenRef.current) {
            frameSeenRef.current = true;
            const pending = pendingStretchRef.current;
            if (pending !== null) {
              pendingStretchRef.current = null;
              pending();
            }
          }
          latestRef.current.cb.onFrame?.(info);
        };

        const options: FitsViewerOptions = { onFrame: onFrameWrapper };
        if (latestRef.current.textureBudget !== undefined) options.textureBudget = latestRef.current.textureBudget;
        if (latestRef.current.hiDpiLevels !== undefined) options.hiDpiLevels = latestRef.current.hiDpiLevels;
        if (latest.northUp !== undefined) options.northUp = latest.northUp;
        // onCursor is fixed at construction: install the trampoline only when the
        // host wants the readout now (so the core skips pointer work otherwise).
        if (latestRef.current.cb.onCursor !== undefined) {
          options.onCursor = (info) => latestRef.current.cb.onCursor?.(info);
        }

        let viewer: CoreViewer;
        try {
          // Build the source from `latest.view` (not the view loadViewerSource used):
          // every band is loaded, so if the host switched view mid-load the viewer is
          // born showing the freshest selection, consistent with `appliedRef = latest`.
          const liveSource = renderSourceForView(latest.view, pyramids);
          viewer = new CoreViewer(canvas, liveSource, options);
        } catch (err) {
          for (const p of pyramids.values()) p.destroy();
          localPyramids = null; // freed here — don't let destroyLocal double-free
          latestRef.current.cb.onError?.(err);
          return;
        }
        localViewer = viewer;
        viewerRef.current = viewer;
        pyramidsRef.current = pyramids;

        // The constructor reflects `latest.view` (the source built from it) +
        // `latest.northUp`; apply the rest from the freshest committed config.
        if (latest.view.mode === 'single' && latest.view.colormap !== undefined) {
          viewer.setColormap(latest.view.colormap);
        }
        if (latest.stretch?.mode !== undefined) viewer.setStretchMode(latest.stretch.mode);
        applyControlledStretch(viewer, latest);
        installMarkerHandlers();
        applyInitialOverlay(viewer, latest);

        // From here the viewer reflects `latest`; the apply effect diffs against it.
        // Every display field was applied above, so no apply-effect re-run is needed
        // now — a later prop change drives it via the signature deps.
        appliedRef.current = latest;
        latestRef.current.cb.onReady?.(handleRef.current as FitsViewerHandle);
      })
      .catch((err: unknown) => {
        if (!cancelled) latestRef.current.cb.onError?.(err);
      });

    return () => {
      cancelled = true;
      // Tear down exactly what this effect instance created; clear the shared refs
      // if they still point at it (a newer load may have already replaced them).
      if (viewerRef.current === localViewer) {
        viewerRef.current = null;
        pyramidsRef.current = null;
        appliedRef.current = null;
      }
      destroyLocal();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bandsKey]);

  // ---- apply controlled display changes to the live viewer ------------------
  // Re-runs when the view/stretch/colormap/north-up signatures change. Bands
  // changes are owned by the load effect — if the plan says reload, this effect
  // leaves the (old/loading) viewer untouched to avoid racing the rebuild. (No
  // viewer-ready dep is needed: the load applies the full config itself, then a
  // later prop change re-runs this effect via the signature deps.)
  const viewKey = viewSignature(props.config.view);
  const colormapKey = colormapSignature(props.config.view);
  const stretchKey = stretchSignature(props.config.stretch);
  const northUpKey = northUpDependency(props.config);
  useEffect(() => {
    const viewer = viewerRef.current;
    const pyramids = pyramidsRef.current;
    const prev = appliedRef.current;
    if (viewer === null || pyramids === null || prev === null) return;
    const next = props.config;
    const plan = planConfigUpdate(prev, next);
    if (plan.reloadBands) return; // owned by the load effect

    if (plan.setSource) viewer.setSource(renderSourceForView(next.view, pyramids));
    if (plan.colormap) {
      viewer.setColormap(next.view.mode === 'single' ? next.view.colormap ?? null : null);
    }
    if (plan.stretchMode) viewer.setStretchMode(next.stretch?.mode ?? DEFAULT_STRETCH_MODE);
    // A source switch needs a fresh stretch: `setSource` leaves channel/stretch
    // state untouched, so the stretch signature can be byte-identical across a
    // single↔rgb flip (both "omitted") yet the new mode still needs auto-stretching
    // — mirror the demo's `setSource` + `autoStretch`. Run the stretch whenever the
    // source changed; otherwise only when the stretch itself changed.
    if (plan.setSource || plan.stretch) applyControlledStretch(viewer, next);
    if (plan.northUp && next.northUp !== undefined) viewer.setNorthUp(next.northUp);

    appliedRef.current = next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewKey, colormapKey, stretchKey, northUpKey]);

  // ---- keep marker handlers in sync when their presence changes -------------
  // The initial install happens in the load effect; this re-runs when the *set* of
  // provided handlers changes (so the core's pointer-work gate stays accurate).
  const hasClick = props.onMarkerClick !== undefined;
  const hasHover = props.onMarkerHover !== undefined;
  const hasTooltip = props.markerTooltip !== undefined;
  useEffect(() => {
    installMarkerHandlers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasClick, hasHover, hasTooltip]);

  const style = props.style === undefined ? CONTAINER_STYLE : { ...CONTAINER_STYLE, ...props.style };
  return (
    <div className={props.className} style={style}>
      <canvas ref={canvasRef} style={CANVAS_STYLE} />
      {props.children}
    </div>
  );
});

/** Apply the config's initial inline overlay markers (a `{ url }` source is the
 *  host's to fetch and push). */
function applyInitialOverlay(viewer: CoreViewer, config: ViewerConfig): void {
  const overlay = config.overlay;
  if (overlay !== undefined && 'markers' in overlay) viewer.setMarkers(overlay.markers);
}

FitsViewerComponent.displayName = 'FitsViewer';

export const FitsViewer = FitsViewerComponent;
export default FitsViewerComponent;

// The batteries-included tier: `<FitsViewer>` + a built-in control panel. Exported
// last so this module's `FitsViewer` binding is defined before `./explorer` (which
// imports it) is evaluated by this re-export.
export { FitsExplorer } from './explorer.js';
export type { FitsExplorerProps } from './explorer.js';
// The decorative boot/placeholder overlay (a `children` of `<FitsViewer>`); the
// batteries-included `<FitsExplorer>` wires it up itself, but a bare-`<FitsViewer>`
// host can drop it in too.
export { FitsLoadingField } from './loading-field.js';
export type { FitsLoadingFieldProps, FitsLoadingFieldHandle } from './loading-field.js';
export {
  defaultExplorerState,
  deriveViewerConfig,
  explorerBandsFromConfig,
  defaultViewFromConfig,
  explorerBandsFromDataset,
  defaultViewFromDataset,
} from './explorer-state.js';
export type { ExplorerBand, ExplorerDefaultView, ExplorerState } from './explorer-state.js';
// Convenience re-exports so a host using only the `/react` subpath can load and
// type the producer contract without also importing the core barrel.
export { loadFitsglConfig, fitsglConfigFromDataset } from '../index.js';
export type { FitsglConfig } from '../index.js';
