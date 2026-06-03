/**
 * FitsViewer — a standalone WebGL2 viewer over a Phase 2b `TilePyramid`.
 *
 * Renders native-pixel image tiles to a canvas with mouse-drag pan, scroll-wheel
 * zoom anchored on the cursor, and an on-the-fly linear stretch applied in the
 * fragment shader (the raw float pixel values live in the textures untouched).
 *
 * Rendering is on demand: a frame is scheduled whenever the camera moves or a
 * tile finishes loading, rather than running a continuous loop. Each frame picks
 * the level whose resolution matches the current zoom, draws the visible tiles,
 * and — for any target tile still loading — draws the best already-resident
 * coarser ancestor in its place for progressive refinement.
 */

import type { TilePyramid } from '../fpack/tile-source.js';
import type { Manifest } from '../manifest.js';
import { Camera } from './camera.js';
import type { WorldBounds } from './camera.js';
import { createColormapTexture, createProgram, createUnitQuadVAO } from './gl-util.js';
import { TILE_VERT } from './shaders/tile.vert.js';
import { TILE_FRAG } from './shaders/tile.frag.js';
import {
  STRETCH_MODE_IDS,
  DEFAULT_TRILOGY_K,
  DEFAULT_TRILOGY_PARAMS,
  trilogyLevels,
  combineTrilogyLuminance,
  type StretchMode,
  type TrilogyStats,
  type TrilogyParams,
  type TrilogyLevels,
} from './stretch.js';
import { resolveColormap, type ColormapLUT, type ColormapName } from './colormaps.js';
import {
  IDENTITY_MAT2,
  anchoredZoomCenter,
  northUpOrientation,
  orientedImageSpan,
  panCenter,
  projectWorldToNdc,
  viewportWorldAABB,
  screenToWorld,
  type Mat2,
} from './view-transform.js';
import { parseWcs, pixToSky, type TanWcs } from '../wcs/tan.js';
import { type GridSpec } from '../wcs/grid-match.js';
import {
  isCompatibleGrid,
  manifestGridSpec,
  normalizeSource,
  type RenderSource,
} from './render-source.js';
import {
  MarkerStore,
  type MarkerEvent,
  type MarkerHandlers,
  type MarkerInput,
  type MarkerPatch,
  type ResolvedMarker,
} from '../overlay/markers.js';
import { packInstances, packOne } from '../overlay/pack.js';
import { GridIndex } from '../overlay/spatial-index.js';
import { broadPhaseWorldRadius, pickMarker, wasClick } from '../overlay/hit-test.js';
import { OverlayRenderer } from '../overlay/overlay-renderer.js';
import { OverlayPopup } from '../overlay/popup.js';
import {
  TileManager,
  buildLevelGeoms,
  coarserFallback,
  commonResidentLevel,
  fallbackUV,
  finerFallback,
  ringTiles,
  targetLevel,
  tileKey,
  tileWorldRect,
  visibleTiles,
  type LevelGeom,
  type TileCoord,
  type WorldRect,
} from './tile-manager.js';
import { histogram, percentileRange, PERCENTILE_SAMPLE_CAP } from './auto-stretch.js';

/** Maximum zoom-in: this many drawing-buffer pixels per native pixel. */
const MAX_NATIVE_ZOOM = 16;
/** Drop tiles not drawn for more than this many frames. */
const MAX_IDLE_FRAMES = 60;
/** Default GPU texture budget (tiles). */
const DEFAULT_TEXTURE_BUDGET = 200;
/**
 * Max decoded tiles uploaded to the GPU per band per frame. Frame-budgets the
 * texImage2D burst when many tiles arrive at once (parallel decode / warm reload
 * from disk); the rest upload over the next frames, masked by coarse-to-fine.
 */
const MAX_UPLOADS_PER_FRAME = 8;
/**
 * Crossfade-in duration (ms) for a tile's first appearance at its own level.
 * The newly-resident tile ramps alpha 0→1 over this window while its fallback
 * (the just-left finer level on zoom-out, or a coarse ancestor) shows through
 * underneath — so a level switch dissolves in rather than popping. Kept short so
 * it reads as a settle, not an animation. 0 disables the fade (pure fallback).
 */
const DEFAULT_CROSSFADE_MS = 150;
/** Prefetch ring width in tiles beyond the viewport edge (P5). */
const PREFETCH_MARGIN = 1;
/** Quiet period after the last camera move before the ring is prefetched (ms). */
const PREFETCH_IDLE_MS = 150;
/** Wheel sensitivity: zoom factor per deltaY unit (exponential). */
const WHEEL_ZOOM_RATE = 0.0015;

/**
 * Read-only viewer state reported once per drawn frame. The viewer renders on
 * demand (not a continuous loop), so `onFrame` fires only when something
 * actually drew — which is exactly the signal a UI needs for an FPS readout, a
 * live zoom/level indicator, or a "stretch the visible data" action.
 */
export interface ViewerFrameInfo {
  /** Monotonic frame counter (also drives the LRU/eviction clock). */
  frame: number;
  /** Drawing-buffer pixels per world (native) pixel. 1.0 = native. */
  zoom: number;
  /** World point at the centre of the viewport (native pixels). */
  centerX: number;
  centerY: number;
  /** Pyramid level chosen for this frame (`targetLevel`). */
  level: number;
  /** World-space rectangle currently visible. */
  bounds: WorldBounds;
  /** Number of tiles at `level` intersecting the viewport. */
  visibleTileCount: number;
  /** Whether North-up rotation is currently applied (a usable WCS + enabled). */
  northUp: boolean;
}

/** Cursor position reported by `onCursor` (world pixel + sky, if a WCS is present). */
export interface CursorInfo {
  /** World (native-pixel) coordinates under the cursor. */
  worldX: number;
  worldY: number;
  /** ICRS sky coordinate (degrees), or null when there is no usable WCS. */
  ra: number | null;
  dec: number | null;
  /** Whether the cursor is within the image's pixel bounds. */
  insideImage: boolean;
  /** The topmost marker under the cursor, or null. Correlates the sky readout
   *  with the overlay hit-test in one event (decision D10). */
  marker: ResolvedMarker | null;
}

/**
 * What `autoStretch` applied, returned so a host can reflect it in its inputs.
 * RGB entries are `null` for a channel whose visible tiles held no finite data
 * (that channel's stretch is left unchanged).
 */
export type AutoStretchResult =
  | { mode: 'single'; min: number; max: number }
  | {
      mode: 'rgb';
      r: [number, number] | null;
      g: [number, number] | null;
      b: [number, number] | null;
    };

/**
 * One band's distribution of the data currently in view: `bins` raw counts over
 * the half-open domain `[lo, hi)`. The domain is a robust wide percentile (not
 * raw min/max) so a few hot pixels don't flatten it; pair it with `setStretch`/
 * `setChannelStretch` to drive a histogram + black/white-point control.
 */
export interface BandHistogram {
  counts: Float32Array;
  lo: number;
  hi: number;
}

/**
 * What `visibleHistogram` returns: one distribution in single-band mode, or one
 * per channel in RGB mode (a channel is `null` when its visible tiles held no
 * finite data — same convention as `AutoStretchResult`).
 */
export type VisibleHistogram =
  | { mode: 'single'; band: BandHistogram }
  | { mode: 'rgb'; r: BandHistogram | null; g: BandHistogram | null; b: BandHistogram | null };

export interface FitsViewerOptions {
  /** GPU texture budget in tiles (LRU by last visible frame). Default 200. */
  textureBudget?: number;
  /**
   * Select pyramid levels at full device-pixel resolution (one texel per
   * drawing-buffer pixel) rather than per CSS pixel. On a HiDPI/retina display
   * this picks a level one octave finer when zoomed out — crisper, but ~4× the
   * tiles and bytes — matching Leaflet's `detectRetina: true`. Default `false`:
   * levels track the *perceived* (CSS) zoom, so zooming out drops to coarser
   * levels sooner. Either way, zooming in to native still loads z=0.
   */
  hiDpiLevels?: boolean;
  /**
   * Crossfade-in duration (ms) for a tile appearing at its own level over its
   * fallback, smoothing zoom-level switches. Default 150; set 0 to disable.
   */
  crossfadeMs?: number;
  /**
   * Called at the end of every drawn frame with read-only viewer state. Use it
   * to drive a telemetry HUD or a visible-data action. Avoid *unconditionally*
   * mutating the viewer from here: a mutation schedules another frame, which
   * calls `onFrame` again — an infinite render loop. Exceptions thrown by the
   * callback are caught and logged so a buggy HUD can't halt rendering.
   */
  onFrame?: (info: ViewerFrameInfo) => void;
  /**
   * Render the image North-up / East-left from the manifest WCS (decision D1).
   * Defaults to `true` when the pyramid carries a usable ICRS TAN WCS, and is
   * forced off (identity orientation) when it does not. Toggle later with
   * `setNorthUp`.
   */
  northUp?: boolean;
  /**
   * Called on cursor movement over the canvas with the world/sky position under
   * the pointer (and the topmost marker, if any), and with `null` when the cursor
   * leaves. Drives a live RA/Dec readout. Independent of North-up: the world->sky
   * mapping is the same whether or not the display is rotated. Coalesced to one
   * call per animation frame.
   */
  onCursor?: (info: CursorInfo | null) => void;
  /**
   * Overlay marker click handler (decision D10). Fires on a non-drag left click
   * over a marker. Settable after construction via `setMarkerHandlers`.
   */
  onMarkerClick?: (e: MarkerEvent) => void;
  /**
   * Overlay marker hover handler: fires when the topmost marker under the pointer
   * *changes* (with the marker, or null on leave). Independent of `onCursor`, so a
   * host wanting only marker events need not also take the RA/Dec readout.
   */
  onMarkerHover?: (e: MarkerEvent | null) => void;
  /**
   * Tooltip content for the built-in popup: called with the hovered marker;
   * return a string (set as text), an `HTMLElement` (rich content), or null to
   * show nothing. The viewer owns one reused popup element.
   */
  markerTooltip?: (m: ResolvedMarker) => string | HTMLElement | null;
}

export class FitsViewer {
  private readonly canvas: HTMLCanvasElement;
  private readonly manifest: Manifest;
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly quadBuffer: WebGLBuffer;
  private readonly camera: Camera;
  /**
   * Tile managers, one per band: length 1 for single-band, length 3 (R, G, B)
   * for an RGB composite. Reassigned by `setSource` (which is grid-preserving),
   * so it is not `readonly`; everything grid-derived below stays `readonly`.
   */
  private bandManagers: TileManager[];
  /**
   * The pyramids behind `bandManagers`, in the same order. Kept so `autoStretch`
   * can read decoded tile values (the managers hold only GPU textures). Length 1
   * for single-band, 3 (R, G, B) for RGB; reassigned by `setSource`.
   */
  private bandPyramids: TilePyramid[];
  /** 'single' or 'rgb' — which draw path and shader mode this frame uses. */
  private mode: 'single' | 'rgb';
  /** Per-band GPU texture budget; each manager gets this (so RGB ≈ 3× resident). */
  private readonly textureBudget: number;
  /** The construction-time grid every `setSource` band must match (D7). */
  private readonly gridSpec: GridSpec;
  private readonly geoms: Map<number, LevelGeom>;
  private readonly maxLevel: number;
  private readonly nativeW: number;
  private readonly nativeH: number;
  private readonly onFrame?: (info: ViewerFrameInfo) => void;
  private readonly hiDpiLevels: boolean;
  /** Crossfade-in duration (ms); 0 disables the fade. See DEFAULT_CROSSFADE_MS. */
  private readonly crossfadeMs: number;
  /** Wall-clock ms captured at the top of the current frame (drives crossfades). */
  private frameNow = 0;
  /** Set when a tile faded in this frame; keeps the loop alive until fades end. */
  private fadeActive = false;
  /** devicePixelRatio of the backing store; kept in sync by syncCanvasSize. */
  private dpr = 1;

  private readonly uP00: WebGLUniformLocation | null;
  private readonly uP10: WebGLUniformLocation | null;
  private readonly uP01: WebGLUniformLocation | null;
  private readonly uP11: WebGLUniformLocation | null;
  private readonly uUV: WebGLUniformLocation | null;
  private readonly uMin: WebGLUniformLocation | null;
  private readonly uMax: WebGLUniformLocation | null;
  private readonly uTile: WebGLUniformLocation | null;
  private readonly uTileG: WebGLUniformLocation | null;
  private readonly uTileB: WebGLUniformLocation | null;
  private readonly uMinRGB: WebGLUniformLocation | null;
  private readonly uMaxRGB: WebGLUniformLocation | null;
  private readonly uMode: WebGLUniformLocation | null;
  private readonly uStretchMode: WebGLUniformLocation | null;
  private readonly uUseColormap: WebGLUniformLocation | null;
  private readonly uColormap: WebGLUniformLocation | null;
  private readonly uOpacity: WebGLUniformLocation | null;
  private readonly uTrilogyK: WebGLUniformLocation | null;
  private readonly uTrilogyLsat: WebGLUniformLocation | null;

  private stretchMin = 0;
  private stretchMax = 1;
  private stretchMode: StretchMode = 'linear';
  /** Per-channel display interval for RGB mode (R, G, B). The transfer curve
   *  (`stretchMode`) is shared across channels; only min/max are independent.
   *  In trilogy mode `channelMin` carries the per-channel black points (`x0`). */
  private channelMin: [number, number, number] = [0, 0, 0];
  private channelMax: [number, number, number] = [1, 1, 1];
  /** Trilogy softening (mode 3); single-band uses its own, RGB uses the shared
   *  luminance one. `DEFAULT_TRILOGY_K` until levels are solved. */
  private trilogyK = DEFAULT_TRILOGY_K;
  /** Trilogy RGB: bias-subtracted luminance that maps to output 1. */
  private trilogyLsat = 1;
  /** Single-band colormap LUT (texture unit 1), or null for grayscale. */
  private colormapTexture: WebGLTexture | null = null;

  /** Parsed manifest WCS (z=0), or null if absent/unsupported. */
  private readonly wcs: TanWcs | null;
  /** North-up orientation for `wcs` at the image centre; identity if no WCS. */
  private readonly northUpMatrix: Mat2;
  /** Whether North-up is currently applied (also requires a usable WCS). */
  private northUpEnabled: boolean;

  private readonly onCursor?: (info: CursorInfo | null) => void;

  // ---- overlay (M3, decision D10) ----------------------------------------
  private readonly overlay: OverlayRenderer;
  private readonly markers = new MarkerStore();
  private grid = new GridIndex([]);
  private readonly popup: OverlayPopup;
  private markerHandlers: MarkerHandlers;
  /** Latest un-processed pointer sample; picking is coalesced to one rAF. */
  private pendingPointer: { bufX: number; bufY: number; cssX: number; cssY: number; event: MouseEvent } | null = null;
  private pointerScheduled = false;
  private pointerRaf = 0;
  /** Id of the marker currently hovered, so onMarkerHover fires only on change. */
  private hoveredId: string | null = null;
  /** Left-button press position (buffer px), for click-vs-drag discrimination. */
  private pressX = 0;
  private pressY = 0;

  private frameCounter = 0;
  private renderScheduled = false;
  private destroyed = false;
  /** Whether the camera has settled (no move for PREFETCH_IDLE_MS): gates ring
   *  prefetch so it never competes with visible-tile fetches mid-interaction. */
  private cameraIdle = false;
  private idleTimerId: ReturnType<typeof setTimeout> | 0 = 0;
  /** Level + world bounds of the last drawn frame; `autoStretch` reuses them so
   *  it samples exactly the tiles already on screen (cache hits). */
  private lastLevel = 0;
  private lastBounds: WorldBounds | null = null;

  private dragging = false;
  private lastDragX = 0;
  private lastDragY = 0;

  private resizeObserver: ResizeObserver | null = null;

  // Bound handlers, retained so destroy() can detach exactly what it attached.
  private readonly onMouseDown: (e: MouseEvent) => void;
  private readonly onMouseMove: (e: MouseEvent) => void;
  private readonly onMouseUp: (e: MouseEvent) => void;
  private readonly onWheel: (e: WheelEvent) => void;
  private readonly onCanvasMove: (e: MouseEvent) => void;
  private readonly onCanvasLeave: () => void;
  private readonly frame: () => void;
  private readonly pointerFrame: () => void;

  constructor(
    canvas: HTMLCanvasElement,
    source: TilePyramid | RenderSource,
    options: FitsViewerOptions = {},
  ) {
    this.canvas = canvas;
    const norm = normalizeSource(source);
    this.mode = norm.mode;
    // The representative band defines the grid/WCS; in RGB mode every band shares
    // it (verified below), so any band would do.
    const representative = norm.pyramids[0];
    this.manifest = representative.getManifest();
    const [nativeH, nativeW] = this.manifest.native_shape;
    this.nativeW = nativeW;
    this.nativeH = nativeH;
    this.maxLevel = this.manifest.n_levels;
    this.geoms = buildLevelGeoms(this.manifest);
    this.textureBudget = options.textureBudget ?? DEFAULT_TEXTURE_BUDGET;
    this.gridSpec = manifestGridSpec(this.manifest);
    this.onFrame = options.onFrame;
    this.onCursor = options.onCursor;
    this.hiDpiLevels = options.hiDpiLevels ?? false;
    this.crossfadeMs = Math.max(0, options.crossfadeMs ?? DEFAULT_CROSSFADE_MS);

    // North-up: parse the z=0 WCS (world pixels are native = z=0 pixels) and
    // precompute the orientation at the image centre once — it is a fixed rigid
    // rotation, so pan/zoom preserve it (decision D1/D2). Default on when usable.
    const z0 = this.manifest.levels.find((l) => l.z === 0);
    this.wcs = z0 !== undefined ? parseWcs(z0.wcs) : null;
    this.northUpMatrix =
      this.wcs !== null ? northUpOrientation(this.wcs, nativeW / 2, nativeH / 2) : IDENTITY_MAT2;
    this.northUpEnabled = (options.northUp ?? true) && this.wcs !== null;

    // `alpha: false`: the viewer fully paints the canvas (opaque clear + tiles),
    // so an opaque drawing buffer is correct and avoids the page-composite halo
    // that a premultiplied-alpha context would show where the marker AA fringe
    // drops the framebuffer alpha below 1.
    const gl = canvas.getContext('webgl2', { alpha: false });
    if (gl === null) {
      throw new Error(
        'FitsViewer: WebGL2 is not available (canvas.getContext("webgl2") returned null).',
      );
    }
    this.gl = gl;

    this.program = createProgram(gl, TILE_VERT, TILE_FRAG);
    const quad = createUnitQuadVAO(gl);
    this.vao = quad.vao;
    this.quadBuffer = quad.buffer;
    this.uP00 = gl.getUniformLocation(this.program, 'u_p00');
    this.uP10 = gl.getUniformLocation(this.program, 'u_p10');
    this.uP01 = gl.getUniformLocation(this.program, 'u_p01');
    this.uP11 = gl.getUniformLocation(this.program, 'u_p11');
    this.uUV = gl.getUniformLocation(this.program, 'u_uv');
    this.uMin = gl.getUniformLocation(this.program, 'u_min');
    this.uMax = gl.getUniformLocation(this.program, 'u_max');
    this.uTile = gl.getUniformLocation(this.program, 'u_tile');
    this.uTileG = gl.getUniformLocation(this.program, 'u_tileG');
    this.uTileB = gl.getUniformLocation(this.program, 'u_tileB');
    this.uMinRGB = gl.getUniformLocation(this.program, 'u_minRGB');
    this.uMaxRGB = gl.getUniformLocation(this.program, 'u_maxRGB');
    this.uMode = gl.getUniformLocation(this.program, 'u_mode');
    this.uStretchMode = gl.getUniformLocation(this.program, 'u_stretchMode');
    this.uUseColormap = gl.getUniformLocation(this.program, 'u_useColormap');
    this.uColormap = gl.getUniformLocation(this.program, 'u_colormap');
    this.uOpacity = gl.getUniformLocation(this.program, 'u_opacity');
    this.uTrilogyK = gl.getUniformLocation(this.program, 'u_trilogyK');
    this.uTrilogyLsat = gl.getUniformLocation(this.program, 'u_trilogyLsat');

    this.camera = new Camera(Math.max(1, canvas.width), Math.max(1, canvas.height));
    // In RGB mode every band must share the construction grid (identical shape +
    // WCS), so compositing samples all three at one shared texcoord (D7). Verify
    // the non-representative bands before building managers; throw on mismatch.
    for (let i = 1; i < norm.pyramids.length; i++) {
      this.assertCompatibleGrid(norm.pyramids[i]);
    }
    this.bandManagers = norm.pyramids.map(
      (p) => new TileManager(gl, p, this.geoms, this.textureBudget, () => this.requestRender()),
    );
    this.bandPyramids = norm.pyramids;
    // Prime the coarsest level (one tile per band) so the viewer shows a whole-
    // image low-res preview almost immediately rather than staying blank until the
    // target level loads. Single-band uses it as the last-resort coarse-to-fine
    // fallback (coarserFallback walks up to maxLevel); RGB additionally needs it so
    // the common-level-hold always has a common ancestor. draw() re-acquires it
    // every frame so it is never evicted (see the pin in draw()).
    for (const m of this.bandManagers) m.request(this.maxLevel, 0, 0);

    // Overlay subsystem (M3): the instanced marker renderer + a reused DOM popup.
    // The marker store/grid stay empty until the host adds markers.
    this.overlay = new OverlayRenderer(gl);
    this.popup = new OverlayPopup();
    this.markerHandlers = {
      onMarkerClick: options.onMarkerClick,
      onMarkerHover: options.onMarkerHover,
      markerTooltip: options.markerTooltip,
    };

    gl.clearColor(0, 0, 0, 1);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    this.frame = () => {
      this.renderScheduled = false;
      if (!this.destroyed) this.draw();
    };
    this.pointerFrame = () => {
      this.pointerScheduled = false;
      if (!this.destroyed) this.processPointer();
    };

    this.onMouseDown = (e) => {
      if (e.button !== 0) return;
      this.dragging = true;
      const p = this.toBufferCoords(e);
      this.lastDragX = p.x;
      this.lastDragY = p.y;
      // Remember the press for click-vs-drag discrimination on mouseup.
      this.pressX = p.x;
      this.pressY = p.y;
    };
    this.onMouseMove = (e) => {
      if (!this.dragging) return;
      const p = this.toBufferCoords(e);
      // Pan through the current orientation so a drag moves the grabbed point
      // with the cursor under North-up too (not just when the view is unrotated).
      const c = panCenter(this.camera, this.currentOrientation(), p.x - this.lastDragX, p.y - this.lastDragY);
      this.camera.setCenter(c.centerX, c.centerY);
      this.lastDragX = p.x;
      this.lastDragY = p.y;
      this.markCameraMoved();
      this.requestRender();
    };
    this.onMouseUp = (e) => {
      // `dragging` is set only by a press that began on the canvas, so it gates
      // out a window mouseup whose mousedown landed elsewhere (which would reuse
      // a stale press position and could spuriously fire onMarkerClick).
      const pressedOnCanvas = this.dragging;
      this.dragging = false;
      if (e.button !== 0 || !pressedOnCanvas) return;
      const onClick = this.markerHandlers.onMarkerClick;
      if (onClick === undefined) return;
      const p = this.toBufferCoords(e);
      // Only a press+release that didn't travel (a click, not a pan) can hit a
      // marker — using mousedown/up rather than the DOM `click`, which can't see
      // the drag distance.
      if (!wasClick(this.pressX, this.pressY, p.x, p.y, this.dpr)) return;
      const marker = this.hitTest(p.x, p.y);
      if (marker !== null) onClick(this.buildMarkerEvent(marker, e));
    };
    this.onWheel = (e) => {
      e.preventDefault();
      const p = this.toBufferCoords(e);
      const target = this.camera.zoom * Math.pow(2, -e.deltaY * WHEEL_ZOOM_RATE);
      // Anchor the zoom on the world point under the cursor *through the current
      // orientation* — otherwise North-up zooms toward a vertically-flipped point.
      const newZoom = this.camera.clampZoom(target);
      const c = anchoredZoomCenter(this.camera, this.currentOrientation(), p.x, p.y, newZoom);
      this.camera.setZoom(newZoom);
      this.camera.setCenter(c.centerX, c.centerY);
      this.markCameraMoved();
      this.requestRender();
    };
    this.onCanvasMove = (e) => {
      // Run when the host wants the cursor readout OR marker hover/tooltip — not
      // coupled to onCursor alone (so a markers-only host still gets hover).
      if (!this.pointerInterest()) return;
      const rect = this.canvas.getBoundingClientRect();
      const cssX = e.clientX - rect.left;
      const cssY = e.clientY - rect.top;
      this.pendingPointer = {
        bufX: cssX * (this.canvas.width / (rect.width || 1)),
        bufY: cssY * (this.canvas.height / (rect.height || 1)),
        cssX,
        cssY,
        event: e,
      };
      this.schedulePointer();
    };
    this.onCanvasLeave = () => {
      this.pendingPointer = null;
      this.onCursor?.(null);
      this.clearHoverState();
    };

    this.syncCanvasSize();
    this.fitToImage();
    this.attachHandlers();
    this.requestRender();
  }

  // ---- public API ---------------------------------------------------------

  setStretch(min: number, max: number): void {
    this.stretchMin = min;
    this.stretchMax = max;
    this.requestRender();
  }

  /** Select the display transfer curve (`'linear'` | `'log'` | `'asinh'`). */
  setStretchMode(mode: StretchMode): void {
    this.stretchMode = mode;
    this.requestRender();
  }

  /**
   * Set the single-band colormap: a bundled palette name (e.g. `'viridis'`), a
   * raw `Uint8Array` of N×3 RGB bytes, or `null`/`'gray'` for the built-in
   * grayscale path (no LUT). The post-stretch [0,1] scalar is mapped through it;
   * the underlying data is never refetched.
   */
  setColormap(spec: ColormapName | ColormapLUT | null): void {
    // 'gray' is the grayscale fast path (no LUT texture), same as null/default.
    if (spec === null || spec === 'gray') {
      this.clearColormapTexture();
      this.requestRender();
      return;
    }
    const { rgba, size } = resolveColormap(spec);
    const next = createColormapTexture(this.gl, size, rgba);
    this.clearColormapTexture();
    this.colormapTexture = next;
    this.requestRender();
  }

  private clearColormapTexture(): void {
    if (this.colormapTexture !== null) {
      this.gl.deleteTexture(this.colormapTexture);
      this.colormapTexture = null;
    }
  }

  /**
   * Stretch to the `[pLo, pHi]` percentile of the data currently in view — the
   * same tiles this frame drew, so they are cache hits. Single-band mode sets the
   * shared stretch; RGB mode sets each channel from its own band, independently
   * (the transfer curve stays shared, D5, so `stretchMode` is untouched).
   *
   * Resolves `null` before the first frame or when no tile is in view; otherwise
   * the applied range(s), so a host can reflect them in its inputs. Promoted from
   * the demo so a host need not import the internal tile-selection helpers (D11).
   */
  async autoStretch(pLo = 0.01, pHi = 0.99): Promise<AutoStretchResult | null> {
    const bounds = this.lastBounds;
    if (bounds === null) return null;
    const level = this.lastLevel;
    const geom = this.geoms.get(level);
    if (geom === undefined) return null;
    const tiles = visibleTiles(geom, bounds);
    if (tiles.length === 0) return null;

    // lastLevel/lastBounds may predate a just-applied `setSource` (e.g. the RGB
    // toggle calls this right after switching bands), but every band shares the
    // grid (D7) and the viewport is unchanged — so the tile coords stay valid and
    // we simply sample the same tiles from the new bands' pyramids.
    if (this.mode === 'rgb') {
      // mode==='rgb' ⇒ bandPyramids has exactly 3 entries (normalizeSource invariant).
      const roles = ['r', 'g', 'b'] as const;
      const out: AutoStretchResult = { mode: 'rgb', r: null, g: null, b: null };
      for (let i = 0; i < 3; i++) {
        const range = await this.sampleVisiblePercentile(this.bandPyramids[i], level, tiles, pLo, pHi);
        out[roles[i]] = range;
        if (range !== null) this.setChannelStretch(roles[i], range[0], range[1]);
      }
      return out;
    }

    const range = await this.sampleVisiblePercentile(this.bandPyramids[0], level, tiles, pLo, pHi);
    if (range === null) return null;
    this.setStretch(range[0], range[1]);
    return { mode: 'single', min: range[0], max: range[1] };
  }

  /**
   * The level + tile coords drawn last frame — the set `autoStretch` and
   * `visibleHistogram` sample, so they read exactly what's on screen (cache hits).
   * Returns null before the first frame or when nothing is in view.
   */
  private gatherVisibleTiles(): { level: number; tiles: readonly TileCoord[] } | null {
    const bounds = this.lastBounds;
    if (bounds === null) return null;
    const level = this.lastLevel;
    const geom = this.geoms.get(level);
    if (geom === undefined) return null;
    const tiles = visibleTiles(geom, bounds);
    if (tiles.length === 0) return null;
    return { level, tiles };
  }

  /**
   * The distribution of the data currently in view, as `bins` counts per active
   * band over a robust `[lo, hi]` domain (the 0.1–99.9 percentile, so hot pixels
   * don't flatten it). Single-band → one histogram; RGB → one per channel (each
   * null when that band's visible tiles held no finite data). Resolves null before
   * the first frame or when no tile is in view. Samples the same tiles the last
   * frame drew (cache hits) — the host-facing companion to `autoStretch` for a
   * histogram + black/white-point control (decision D11: a supported capability,
   * not a reach into the internal tile helpers).
   */
  async visibleHistogram(bins = 128): Promise<VisibleHistogram | null> {
    const gathered = this.gatherVisibleTiles();
    if (gathered === null) return null;
    const { level, tiles } = gathered;
    const bandHist = async (pyramid: TilePyramid): Promise<BandHistogram | null> => {
      let arrays: Float32Array[];
      try {
        arrays = await Promise.all(tiles.map((t) => pyramid.getTile(level, t.tileX, t.tileY)));
      } catch (err) {
        console.warn('FitsViewer.visibleHistogram: tile fetch failed; skipping this band:', err);
        return null;
      }
      const domain = percentileRange(arrays, 0.001, 0.999, PERCENTILE_SAMPLE_CAP);
      if (domain === null) return null;
      const [lo, hi] = domain;
      return { counts: histogram(arrays, bins, lo, hi, PERCENTILE_SAMPLE_CAP), lo, hi };
    };
    if (this.mode === 'rgb') {
      // mode==='rgb' ⇒ bandPyramids has exactly 3 entries (normalizeSource invariant).
      const [r, g, b] = await Promise.all([
        bandHist(this.bandPyramids[0]),
        bandHist(this.bandPyramids[1]),
        bandHist(this.bandPyramids[2]),
      ]);
      return { mode: 'rgb', r, g, b };
    }
    const band = await bandHist(this.bandPyramids[0]);
    return band === null ? null : { mode: 'single', band };
  }

  /** Fetch the given tiles from `pyramid` (cache hits) and percentile them. */
  private async sampleVisiblePercentile(
    pyramid: TilePyramid,
    level: number,
    tiles: readonly TileCoord[],
    pLo: number,
    pHi: number,
  ): Promise<[number, number] | null> {
    try {
      const arrays = await Promise.all(tiles.map((t) => pyramid.getTile(level, t.tileX, t.tileY)));
      return percentileRange(arrays, pLo, pHi, PERCENTILE_SAMPLE_CAP);
    } catch (err) {
      // A tile fetch can fail (network/decoder); auto-stretch is best-effort, so
      // skip this band rather than reject the caller — but keep it visible.
      console.warn('FitsViewer.autoStretch: tile fetch failed; leaving this band unchanged:', err);
      return null;
    }
  }

  // ---- RGB compositing (M4, decisions D7/D8) -----------------------------

  /**
   * Switch what the viewer draws between a single band and an RGB composite, or
   * swap which pyramids fill R/G/B — live, for a band-picker UX. Every band in
   * the new source must share the construction grid (identical shape + WCS, D7);
   * a mismatch throws and the current source is kept. The grid is preserved, so
   * North-up, the cursor sky readout, and any markers stay registered. New
   * managers are built and primed before the old ones are destroyed, so GPU
   * textures are never leaked. (A genuinely different grid needs a new viewer.)
   */
  setSource(source: RenderSource): void {
    const norm = normalizeSource(source);
    for (const p of norm.pyramids) this.assertCompatibleGrid(p);

    const next = norm.pyramids.map(
      (p) => new TileManager(this.gl, p, this.geoms, this.textureBudget, () => this.requestRender()),
    );
    // Prime the coarsest level for the new managers (mirrors the constructor).
    for (const m of next) m.request(this.maxLevel, 0, 0);
    const old = this.bandManagers;
    this.bandManagers = next;
    this.bandPyramids = norm.pyramids;
    this.mode = norm.mode;
    for (const m of old) m.destroy();
    this.requestRender();
  }

  /**
   * Set one RGB channel's display interval (min/max). RGB only — in single-band
   * mode use `setStretch`. The transfer curve set by `setStretchMode` is shared
   * across all three channels (decision D5); only the per-channel min/max are
   * independent.
   */
  setChannelStretch(role: 'r' | 'g' | 'b', min: number, max: number): void {
    const i = role === 'r' ? 0 : role === 'g' ? 1 : 2;
    this.channelMin[i] = min;
    this.channelMax[i] = max;
    this.requestRender();
  }

  /** Whether the viewer is currently in RGB composite mode. */
  get isRgb(): boolean {
    return this.mode === 'rgb';
  }

  /**
   * Apply a faithful, color-preserving trilogy stretch from precomputed global
   * per-band stats (`FitsglBandStats`), with no tile rescan — the producer's
   * `mean`/`sigma`/`tail` already describe the whole image at native resolution,
   * so the levels are stable and viewport-independent on the first paint.
   *
   * Single-band: pass one stats object; sets `[x0, x2]` and the solved softening.
   * RGB: pass `[r, g, b]` stats; sets each channel's black point (`x0`) and the
   * shared luminance saturation + softening that preserves color ratios. Does not
   * switch mode — call `setStretchMode('trilogy')` to select the curve. Returns
   * the per-channel levels it applied so a host can reflect them in its inputs.
   */
  applyTrilogy(
    stats: TrilogyStats | readonly [TrilogyStats, TrilogyStats, TrilogyStats],
    params: TrilogyParams = DEFAULT_TRILOGY_PARAMS,
  ): TrilogyLevels[] {
    if (this.mode === 'rgb') {
      if (!Array.isArray(stats) || stats.length !== 3) {
        throw new Error('applyTrilogy: RGB mode needs [r, g, b] stats');
      }
      const triple = stats as readonly [TrilogyStats, TrilogyStats, TrilogyStats];
      const levels = triple.map((s) => trilogyLevels(s, params)) as [
        TrilogyLevels,
        TrilogyLevels,
        TrilogyLevels,
      ];
      // Per-channel black points (x0) ride in channelMin (u_minRGB); the shared
      // luminance stretch carries saturation + softening.
      for (let i = 0; i < 3; i++) this.channelMin[i] = levels[i].x0;
      const lum = combineTrilogyLuminance(levels, params.noiselum);
      this.trilogyLsat = lum.lsat;
      this.trilogyK = lum.k;
      this.requestRender();
      return levels;
    }
    if (Array.isArray(stats)) {
      throw new Error('applyTrilogy: single-band mode needs one stats object');
    }
    const lv = trilogyLevels(stats as TrilogyStats, params);
    this.stretchMin = lv.x0;
    this.stretchMax = lv.x2;
    this.trilogyK = lv.k;
    this.requestRender();
    return [lv];
  }

  /**
   * Throw unless `pyramid` shares the viewer's construction grid: identical
   * native shape + WCS (`gridsMatch`) and identical per-level geometry
   * (`geomsEqual`, which catches a same-shape pyramid built with a different
   * tile size). This is what lets every band reuse the one set of grid-derived
   * viewer state and one shared UV per composite tile.
   */
  private assertCompatibleGrid(pyramid: TilePyramid): void {
    if (!isCompatibleGrid(this.gridSpec, this.geoms, pyramid.getManifest())) {
      throw new Error(
        'FitsViewer: RGB band grid does not match the viewer grid — identical native shape and WCS are required for compositing (decision D7).',
      );
    }
  }

  /**
   * Turn North-up rendering on or off. A no-op (stays off) when the pyramid has
   * no usable WCS. Re-fits the zoom limits to the new orientation's extent and
   * keeps the current centre.
   */
  setNorthUp(enabled: boolean): void {
    const next = enabled && this.wcs !== null;
    if (next === this.northUpEnabled) return;
    this.northUpEnabled = next;
    this.updateZoomLimits();
    this.requestRender();
  }

  /** Whether North-up is currently applied. */
  get isNorthUp(): boolean {
    return this.northUpEnabled;
  }

  // ---- overlay markers (M3, decision D10) --------------------------------

  /**
   * Add markers, returning the resolved id of each input in order (auto-filled
   * where omitted). Sky (`ra`/`dec`) markers require a usable WCS at construction
   * — a marker that cannot be placed is dropped (its id is still returned, but a
   * later `updateMarker`/`removeMarker` on it is a no-op). Throws on a duplicate id.
   */
  addMarkers(markers: MarkerInput[]): string[] {
    const ids = this.markers.add(markers, this.wcs);
    this.rebuildGrid();
    this.rebuildOverlayBuffer();
    this.requestRender();
    return ids;
  }

  /** Replace all markers (clear + add). Returns the new ids. */
  setMarkers(markers: MarkerInput[]): string[] {
    const ids = this.markers.replace(markers, this.wcs);
    this.clearHoverState(); // the hovered marker may no longer exist
    this.rebuildGrid();
    this.rebuildOverlayBuffer();
    this.requestRender();
    return ids;
  }

  /**
   * Patch one marker by id (style, position, or data). Returns whether the id
   * existed. A style-only change is O(1) — a single instance slot re-uploaded; a
   * position change additionally rebuilds the hit-test grid.
   */
  updateMarker(id: string, patch: MarkerPatch): boolean {
    const res = this.markers.update(id, patch, this.wcs);
    if (res === null) return false;
    const marker = this.markers.at(res.index);
    if (marker !== undefined) this.overlay.updateInstance(res.index, packOne(marker));
    if (res.positionChanged) this.rebuildGrid();
    this.requestRender();
    return true;
  }

  /** Remove one marker by id. Returns whether it existed. */
  removeMarker(id: string): boolean {
    if (!this.markers.remove(id)) return false;
    if (this.hoveredId === id) this.clearHoverState();
    this.rebuildGrid();
    this.rebuildOverlayBuffer();
    this.requestRender();
    return true;
  }

  /** Remove all markers. */
  clearMarkers(): void {
    if (this.markers.count === 0) return;
    this.markers.clear();
    this.clearHoverState();
    this.rebuildGrid();
    this.rebuildOverlayBuffer();
    this.requestRender();
  }

  /**
   * Set the overlay interaction handlers (click / hover / tooltip), replacing any
   * previously set. A React wrapper can call this each render with fresh closures
   * without rebuilding the viewer; omit a field to disable it.
   */
  setMarkerHandlers(handlers: MarkerHandlers): void {
    this.markerHandlers = handlers;
    if (handlers.markerTooltip === undefined) this.popup.hide();
  }

  /** The orientation matrix to apply this frame (identity when North-up is off). */
  private currentOrientation(): Mat2 {
    return this.northUpEnabled && this.wcs !== null ? this.northUpMatrix : IDENTITY_MAT2;
  }

  setCenter(x: number, y: number): void {
    this.camera.setCenter(x, y);
    this.markCameraMoved();
    this.requestRender();
  }

  setZoom(zoom: number): void {
    this.camera.setZoom(zoom);
    this.markCameraMoved();
    this.requestRender();
  }

  /** Centre the image and zoom so the whole mosaic is visible. */
  fitToImage(): void {
    this.camera.setCenter(this.nativeW / 2, this.nativeH / 2);
    this.camera.setZoom(this.fitZoom());
    this.markCameraMoved();
    this.requestRender();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.pointerScheduled) cancelAnimationFrame(this.pointerRaf);
    if (this.idleTimerId !== 0) clearTimeout(this.idleTimerId);
    this.detachHandlers();
    for (const m of this.bandManagers) m.destroy();
    this.clearColormapTexture();
    this.overlay.destroy(); // marker program, VAO, instance + quad buffers
    this.popup.destroy(); // remove the popup DOM node
    this.gl.deleteProgram(this.program);
    this.gl.deleteVertexArray(this.vao);
    this.gl.deleteBuffer(this.quadBuffer); // deleteVertexArray does not free it
    // The pyramid is caller-owned and intentionally not destroyed here.
  }

  // ---- sizing / zoom limits ----------------------------------------------

  /**
   * Smallest zoom that still fits the whole image in the viewport, accounting
   * for the current orientation (a rotated image has a larger screen footprint).
   */
  private fitZoom(): number {
    const { spanX, spanY } = orientedImageSpan(
      this.currentOrientation(),
      this.nativeW,
      this.nativeH,
    );
    return Math.min(this.camera.viewportWidth / spanX, this.camera.viewportHeight / spanY);
  }

  /**
   * Recompute the camera zoom limits from the current fit zoom. Zoom-out is
   * bounded at "whole (oriented) mosaic visible"; zoom-in at MAX_NATIVE_ZOOM
   * native pixels — but never below the fit zoom, so a mosaic smaller than the
   * viewport (fit zoom > 16×) still fits instead of pinning at the ceiling.
   */
  private updateZoomLimits(): void {
    const fit = this.fitZoom();
    this.camera.setZoomLimits(fit, Math.max(fit, MAX_NATIVE_ZOOM * this.dpr));
  }

  /**
   * Match the drawing buffer to the canvas's displayed size (× devicePixelRatio)
   * and update the camera viewport and zoom limits. Zoom-out is bounded at
   * "whole mosaic visible", zoom-in at MAX_NATIVE_ZOOM native pixels.
   */
  private syncCanvasSize(): void {
    const dpr =
      typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1;
    this.dpr = dpr;
    const rect = this.canvas.getBoundingClientRect();
    const cssW = rect.width || this.canvas.width || 1;
    const cssH = rect.height || this.canvas.height || 1;
    const bw = Math.max(1, Math.round(cssW * dpr));
    const bh = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== bw) this.canvas.width = bw;
    if (this.canvas.height !== bh) this.canvas.height = bh;
    this.camera.setViewport(bw, bh);
    this.updateZoomLimits();
  }

  // ---- event wiring -------------------------------------------------------

  private attachHandlers(): void {
    this.canvas.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mouseup', this.onMouseUp);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('mousemove', this.onCanvasMove);
    this.canvas.addEventListener('mouseleave', this.onCanvasLeave);
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        this.syncCanvasSize();
        this.requestRender();
      });
      this.resizeObserver.observe(this.canvas);
    }
  }

  private detachHandlers(): void {
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mouseup', this.onMouseUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('mousemove', this.onCanvasMove);
    this.canvas.removeEventListener('mouseleave', this.onCanvasLeave);
    if (this.resizeObserver !== null) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
  }

  /** Convert a mouse event's client coords to drawing-buffer pixels. */
  private toBufferCoords(e: MouseEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (this.canvas.width / (rect.width || 1)),
      y: (e.clientY - rect.top) * (this.canvas.height / (rect.height || 1)),
    };
  }

  // ---- rendering ----------------------------------------------------------

  private requestRender(): void {
    if (this.destroyed || this.renderScheduled) return;
    this.renderScheduled = true;
    requestAnimationFrame(this.frame);
  }

  /**
   * Note a camera change: clear the idle flag and (re)arm a debounce so the
   * prefetch ring fires only once interaction settles (PREFETCH_IDLE_MS after the
   * last move). The fired timer schedules a frame so the now-idle draw prefetches.
   * Cheap enough to call on every pointer move.
   */
  private markCameraMoved(): void {
    this.cameraIdle = false;
    if (this.idleTimerId !== 0) clearTimeout(this.idleTimerId);
    this.idleTimerId = setTimeout(() => {
      this.idleTimerId = 0;
      if (this.destroyed) return;
      this.cameraIdle = true;
      this.requestRender();
    }, PREFETCH_IDLE_MS);
  }

  private draw(): void {
    const gl = this.gl;
    this.frameCounter++;
    this.frameNow = performance.now();
    // Reset each frame; the tile passes set it when a tile is mid-crossfade so the
    // loop keeps drawing until the fade completes (see end of draw()).
    this.fadeActive = false;
    // One frame clock per band; advance all so each manager's LRU stays in step
    // (a desync would let a band evict tiles its siblings still need to composite).
    for (const m of this.bandManagers) m.frame = this.frameCounter;

    // Drain a bounded number of pending GPU uploads per band before drawing, so a
    // burst of decoded tiles can't stall the frame; uploaded tiles draw this frame.
    // The upload timestamp stamps each tile's crossfade-in start.
    let queuedUploads = 0;
    for (const m of this.bandManagers) {
      queuedUploads += m.flushUploads(MAX_UPLOADS_PER_FRAME, this.frameNow);
    }

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    // The transfer curve is shared by single-band and RGB (decision D5).
    gl.uniform1i(this.uStretchMode, STRETCH_MODE_IDS[this.stretchMode]);
    // Trilogy softening + luminance saturation (mode 3); inert for other modes.
    gl.uniform1f(this.uTrilogyK, this.trilogyK);
    gl.uniform1f(this.uTrilogyLsat, this.trilogyLsat);

    const orient = this.currentOrientation();
    // Under rotation the viewport maps to a rotated world rectangle; intersect
    // its axis-aligned bounding box (from all four corners). This slightly
    // over-selects tiles at the corners — expected, not a correctness issue.
    const bounds = viewportWorldAABB(this.camera, orient);
    // Select levels by perceived (CSS) zoom by default: `camera.zoom` is
    // drawing-buffer px per world px, so on a HiDPI display it runs `dpr`× ahead
    // of what the user sees and would keep z=0 resident far past native. Dividing
    // by dpr drops to coarser levels as soon as the *displayed* image shrinks
    // below native (Leaflet's default). `hiDpiLevels` opts back into full
    // device-pixel crispness. Tile selection is grid-only, so it is identical
    // for every band and computed once.
    const selectionZoom = this.hiDpiLevels ? this.camera.zoom : this.camera.zoom / this.dpr;
    const level = targetLevel(selectionZoom, this.maxLevel);
    // Remember this frame's selection so `autoStretch` samples exactly what drew.
    this.lastLevel = level;
    this.lastBounds = bounds;
    const geom = this.geoms.get(level);
    let visibleTileCount = 0;
    if (geom !== undefined) {
      const tiles = visibleTiles(geom, bounds);
      visibleTileCount = tiles.length;
      if (this.mode === 'rgb') this.drawRgbTiles(orient, geom, level, tiles);
      else this.drawSingleBandTiles(orient, geom, level, tiles);

      // Prefetch ring (P5) + cancel abandoned in-flight fetches (P6a). The
      // retention region is the visible tiles plus a one-tile margin; the ring is
      // requested only when the camera is idle (so it never competes with visible
      // fetches mid-pan), and any in-flight fetch at this level outside the region
      // is aborted (a tile the user scrolled away from before it loaded).
      const ring = ringTiles(geom, bounds, PREFETCH_MARGIN);
      const retain = new Set<string>();
      for (const t of tiles) retain.add(tileKey(level, t.tileX, t.tileY));
      for (const t of ring) retain.add(tileKey(level, t.tileX, t.tileY));
      if (this.cameraIdle) {
        for (const t of ring) {
          for (const m of this.bandManagers) m.request(level, t.tileX, t.tileY);
        }
      }
      for (const m of this.bandManagers) m.cancelExcept(level, retain);
    }

    // Pin the coarsest whole-image tile (per band) as the last-resort coarse-to-
    // fine fallback: re-acquiring it every frame refreshes its last-visible frame
    // so idle/budget eviction never drops it, and a fast pan into never-visited
    // territory shows a blur rather than black. A no-op until the prime loads.
    for (const m of this.bandManagers) m.acquire(this.maxLevel, 0, 0);

    for (const m of this.bandManagers) m.evict(MAX_IDLE_FRAMES);

    // Markers draw on top of the tiles, sharing the oriented transform so they
    // stay registered under pan/zoom and North-up (decision D10). The marker pass
    // binds its own program/VAO; the next frame's tile pass rebinds the tile
    // program/VAO at the top of draw().
    this.overlay.draw({
      centerX: this.camera.centerX,
      centerY: this.camera.centerY,
      zoom: this.camera.zoom,
      viewportWidth: this.canvas.width,
      viewportHeight: this.canvas.height,
      orient,
      pixelRatio: this.dpr,
    });

    if (this.onFrame !== undefined) {
      try {
        this.onFrame({
          frame: this.frameCounter,
          zoom: this.camera.zoom,
          centerX: this.camera.centerX,
          centerY: this.camera.centerY,
          level,
          bounds,
          visibleTileCount,
          northUp: this.northUpEnabled,
        });
      } catch (err) {
        // A telemetry callback must never be able to stop the render loop.
        console.error('FitsViewer: onFrame callback threw:', err);
      }
    }

    // Uploads still queued past this frame's budget: keep drawing to drain them.
    // Coarse-to-fine covers the not-yet-uploaded tiles until they land. A tile
    // mid-crossfade also needs the next frame to advance its alpha ramp.
    if (queuedUploads > 0 || this.fadeActive) this.requestRender();
  }

  /**
   * Single-band tile pass: set the single-band uniforms, then draw each visible
   * tile (or its best coarser ancestor while loading). Byte-identical to the
   * pre-M4 draw loop, operating on the lone band manager.
   */
  private drawSingleBandTiles(
    orient: Mat2,
    geom: LevelGeom,
    level: number,
    tiles: ReadonlyArray<{ tileX: number; tileY: number }>,
  ): void {
    const gl = this.gl;
    gl.uniform1i(this.uMode, 0);
    gl.uniform1f(this.uMin, this.stretchMin);
    gl.uniform1f(this.uMax, this.stretchMax);
    // Colormap LUT lives on texture unit 1; tiles bind to unit 0 in drawTile.
    if (this.colormapTexture !== null) {
      gl.uniform1i(this.uUseColormap, 1);
      gl.uniform1i(this.uColormap, 1);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.colormapTexture);
    } else {
      gl.uniform1i(this.uUseColormap, 0);
    }
    gl.uniform1i(this.uTile, 0);
    // Restore unit 0 as active (an RGB frame leaves it at TEXTURE3); drawTile
    // binds to whichever unit is active.
    gl.activeTexture(gl.TEXTURE0);

    const mgr = this.bandManagers[0];
    for (const t of tiles) {
      const rect = tileWorldRect(geom, t.tileX, t.tileY);
      const entry = mgr.acquire(level, t.tileX, t.tileY);
      if (entry !== undefined) {
        const op = this.fadeOpacity(entry.uploadedAt);
        // While the tile crossfades in, draw its fallback underneath so it
        // dissolves in over real context (the finer detail it covers on a
        // zoom-out, or a coarse ancestor) rather than over the cleared frame.
        if (op < 1) this.drawSingleBandFallback(orient, mgr, level, t.tileX, t.tileY, rect);
        this.drawTile(orient, rect, entry.texture, 0, 0, 1, 1, op);
        continue;
      }
      // Not resident yet: request it, and fill from the best resident neighbour —
      // a finer level if we just zoomed out, else a coarse ancestor (A: D + A).
      mgr.request(level, t.tileX, t.tileY);
      this.drawSingleBandFallback(orient, mgr, level, t.tileX, t.tileY, rect);
    }
  }

  /**
   * Draw the best resident stand-in for a single-band tile that is missing or
   * still crossfading in, as two opaque layers (coarse-to-fine, painter's order):
   *
   *  1. BASE — the finest resident COARSE ancestor, upscaled to fill the tile.
   *     The pinned coarsest tile is the floor, so this never leaves a hole.
   *  2. OVERLAY — any resident descendants at the nearest FINER level (the detail
   *     the user just left on a zoom-out), drawn crisp at their own world rects on
   *     top of the base. Coverage may be partial: sharp where the finer level
   *     loaded, coarse base showing through the gaps.
   *
   * `acquire` marks every consulted tile visible so the fallback levels are not
   * evicted out from under it the next frame (which would re-open the flash).
   */
  private drawSingleBandFallback(
    orient: Mat2,
    mgr: TileManager,
    level: number,
    tileX: number,
    tileY: number,
    rect: WorldRect,
  ): void {
    const fb = coarserFallback(level, tileX, tileY, this.maxLevel, (l, x, y) => mgr.has(l, x, y));
    if (fb !== null) {
      const fbEntry = mgr.acquire(fb.level, fb.tileX, fb.tileY);
      const fbGeom = this.geoms.get(fb.level);
      if (fbEntry !== undefined && fbGeom !== undefined) {
        const ancestor = tileWorldRect(fbGeom, fb.tileX, fb.tileY);
        const [u0, v0, u1, v1] = fallbackUV(rect, ancestor);
        this.drawTile(orient, rect, fbEntry.texture, u0, v0, u1, v1, 1);
      }
    }
    const finer = finerFallback(level, tileX, tileY, (l, x, y) => mgr.has(l, x, y));
    if (finer !== null) {
      const fGeom = this.geoms.get(finer.level);
      if (fGeom !== undefined) {
        for (const ft of finer.tiles) {
          const fe = mgr.acquire(ft.level, ft.tileX, ft.tileY);
          if (fe === undefined) continue; // raced an eviction; skip this sub-tile
          const fRect = tileWorldRect(fGeom, ft.tileX, ft.tileY);
          this.drawTile(orient, fRect, fe.texture, 0, 0, 1, 1, 1);
        }
      }
    }
  }

  /**
   * Crossfade-in alpha in [0,1] for a tile uploaded at `uploadedAt` (wall-clock
   * ms). Returns 1 immediately when the fade is disabled or already complete;
   * while ramping it flags `fadeActive` so the loop schedules the next frame.
   */
  private fadeOpacity(uploadedAt: number): number {
    if (this.crossfadeMs <= 0) return 1;
    const op = (this.frameNow - uploadedAt) / this.crossfadeMs;
    if (op >= 1) return 1;
    this.fadeActive = true;
    return op > 0 ? op : 0;
  }

  /**
   * RGB composite tile pass (decisions D7/D8). Tile selection is grid-only, so
   * the visible tiles are shared by all three bands. For each tile, draw from
   * the finest level common to R, G, AND B (the vertex shader's single shared UV
   * forces one source level + sub-rect across channels); request the target tile
   * from every band; draw nothing for the tile if no common level is resident
   * yet (common-level-hold). The all-three-NaN→transparent rule (D8) lives in
   * the fragment shader.
   */
  private drawRgbTiles(
    orient: Mat2,
    geom: LevelGeom,
    level: number,
    tiles: ReadonlyArray<{ tileX: number; tileY: number }>,
  ): void {
    const gl = this.gl;
    gl.uniform1i(this.uMode, 1);
    gl.uniform3f(this.uMinRGB, this.channelMin[0], this.channelMin[1], this.channelMin[2]);
    gl.uniform3f(this.uMaxRGB, this.channelMax[0], this.channelMax[1], this.channelMax[2]);
    // Sampler units: R→0, G→2, B→3 (the colormap keeps unit 1, unused here). An
    // UNSET sampler2D defaults to unit 0, so G and B MUST be assigned explicitly
    // or they would both sample the R texture.
    gl.uniform1i(this.uTile, 0);
    gl.uniform1i(this.uTileG, 2);
    gl.uniform1i(this.uTileB, 3);

    const mr = this.bandManagers[0];
    const mg = this.bandManagers[1];
    const mb = this.bandManagers[2];
    for (const t of tiles) {
      const rect = tileWorldRect(geom, t.tileX, t.tileY);
      // Drive every band toward the target tile.
      mr.request(level, t.tileX, t.tileY);
      mg.request(level, t.tileX, t.tileY);
      mb.request(level, t.tileX, t.tileY);
      // Target tile resident in ALL three bands? acquire() (not has()) marks each
      // band's consulted tile visible this frame, so a band that is ahead cannot
      // evict a tile its laggard siblings still need (cross-band eviction
      // oscillation). Call all three unconditionally (no && short-circuit).
      const er = mr.acquire(level, t.tileX, t.tileY);
      const eg = mg.acquire(level, t.tileX, t.tileY);
      const eb = mb.acquire(level, t.tileX, t.tileY);
      if (er !== undefined && eg !== undefined && eb !== undefined) {
        // Fade from the newest of the three uploads (when it became drawable).
        const op = this.fadeOpacity(Math.max(er.uploadedAt, eg.uploadedAt, eb.uploadedAt));
        if (op < 1) this.drawRgbFallback(orient, level, t.tileX, t.tileY, rect, mr, mg, mb);
        this.drawTileRGB(orient, rect, er.texture, eg.texture, eb.texture, 0, 0, 1, 1, op);
        continue;
      }
      // Target not common to all three yet: best resident neighbour (a finer
      // level common to every band, else a coarse common ancestor). Draws nothing
      // if no common level is resident (common-level-hold).
      this.drawRgbFallback(orient, level, t.tileX, t.tileY, rect, mr, mg, mb);
    }
  }

  /**
   * Draw the best resident RGB stand-in for a composite tile missing at the
   * target level (or crossfading in), as two layers (coarse base + finer overlay)
   * exactly like `drawSingleBandFallback`. The shader exposes a single shared UV,
   * so all three channels must sample one COMMON source level + sub-rect per draw:
   * the base is the finest COARSE level common to all three, the overlay is the
   * resident descendants common to all three at the nearest finer level. The
   * target level is excluded from the base (fromLevel `level + 1`) — its
   * all-resident case is the caller's, and a fade base must differ from the
   * target. `acquire` marks consulted tiles visible (cross-band eviction guard).
   */
  private drawRgbFallback(
    orient: Mat2,
    level: number,
    tileX: number,
    tileY: number,
    rect: WorldRect,
    mr: TileManager,
    mg: TileManager,
    mb: TileManager,
  ): void {
    // Coarse base: finest level strictly above the target common to all bands.
    const common = commonResidentLevel(
      level,
      tileX,
      tileY,
      this.maxLevel,
      (l, x, y) => {
        const hr = mr.acquire(l, x, y) !== undefined;
        const hg = mg.acquire(l, x, y) !== undefined;
        const hb = mb.acquire(l, x, y) !== undefined;
        return hr && hg && hb;
      },
      level + 1,
    );
    if (common !== null) {
      const er = mr.acquire(common.level, common.tileX, common.tileY);
      const eg = mg.acquire(common.level, common.tileX, common.tileY);
      const eb = mb.acquire(common.level, common.tileX, common.tileY);
      const fbGeom = this.geoms.get(common.level);
      if (er !== undefined && eg !== undefined && eb !== undefined && fbGeom !== undefined) {
        const ancestor = tileWorldRect(fbGeom, common.tileX, common.tileY);
        const [u0, v0, u1, v1] = fallbackUV(rect, ancestor);
        this.drawTileRGB(orient, rect, er.texture, eg.texture, eb.texture, u0, v0, u1, v1, 1);
      }
    }
    // Finer overlay: resident descendants common to all three bands (partial OK).
    const finer = finerFallback(
      level,
      tileX,
      tileY,
      (l, x, y) => mr.has(l, x, y) && mg.has(l, x, y) && mb.has(l, x, y),
    );
    if (finer !== null) {
      const fGeom = this.geoms.get(finer.level);
      if (fGeom !== undefined) {
        for (const ft of finer.tiles) {
          const tr = mr.acquire(ft.level, ft.tileX, ft.tileY);
          const tg = mg.acquire(ft.level, ft.tileX, ft.tileY);
          const tb = mb.acquire(ft.level, ft.tileX, ft.tileY);
          if (tr === undefined || tg === undefined || tb === undefined) continue;
          const fRect = tileWorldRect(fGeom, ft.tileX, ft.tileY);
          this.drawTileRGB(orient, fRect, tr.texture, tg.texture, tb.texture, 0, 0, 1, 1, 1);
        }
      }
    }
  }

  /**
   * Draw a world rectangle textured by `texture` over the [u0,v0]-[u1,v1]
   * sub-rect, under orientation `orient`. The four destination corners are
   * transformed individually so a rotated/flipped orientation draws a rotated
   * quad (not just an axis-aligned rect).
   */
  private drawTile(
    orient: Mat2,
    rect: WorldRect,
    texture: WebGLTexture,
    u0: number,
    v0: number,
    u1: number,
    v1: number,
    opacity: number,
  ): void {
    const gl = this.gl;
    const p00 = this.worldToNdc(orient, rect.x0, rect.y0);
    const p10 = this.worldToNdc(orient, rect.x1, rect.y0);
    const p01 = this.worldToNdc(orient, rect.x0, rect.y1);
    const p11 = this.worldToNdc(orient, rect.x1, rect.y1);
    gl.uniform2f(this.uP00, p00.x, p00.y);
    gl.uniform2f(this.uP10, p10.x, p10.y);
    gl.uniform2f(this.uP01, p01.x, p01.y);
    gl.uniform2f(this.uP11, p11.x, p11.y);
    gl.uniform4f(this.uUV, u0, v0, u1, v1);
    gl.uniform1f(this.uOpacity, opacity);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /**
   * Draw one composite tile from three same-grid band textures (RGB mode). The
   * destination quad and the single shared UV are computed exactly as `drawTile`
   * (same grid ⟹ identical for all three channels); R/G/B bind to texture units
   * 0/2/3 to match the sampler uniforms set in `drawRgbTiles`. Leaves unit 3 as
   * the active unit — the single-band pass re-activates unit 0 before drawing.
   */
  private drawTileRGB(
    orient: Mat2,
    rect: WorldRect,
    texR: WebGLTexture,
    texG: WebGLTexture,
    texB: WebGLTexture,
    u0: number,
    v0: number,
    u1: number,
    v1: number,
    opacity: number,
  ): void {
    const gl = this.gl;
    const p00 = this.worldToNdc(orient, rect.x0, rect.y0);
    const p10 = this.worldToNdc(orient, rect.x1, rect.y0);
    const p01 = this.worldToNdc(orient, rect.x0, rect.y1);
    const p11 = this.worldToNdc(orient, rect.x1, rect.y1);
    gl.uniform2f(this.uP00, p00.x, p00.y);
    gl.uniform2f(this.uP10, p10.x, p10.y);
    gl.uniform2f(this.uP01, p01.x, p01.y);
    gl.uniform2f(this.uP11, p11.x, p11.y);
    gl.uniform4f(this.uUV, u0, v0, u1, v1);
    gl.uniform1f(this.uOpacity, opacity);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texR);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, texG);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, texB);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /**
   * World pixel -> NDC. Delegates to the pure `projectWorldToNdc` (the single
   * source of truth the marker vertex shader transcribes). `camera.viewportWidth/
   * Height` equal `canvas.width/height` — `syncCanvasSize` keeps them in sync — so
   * this is identical to dividing by the canvas backing-store size.
   */
  private worldToNdc(orient: Mat2, worldX: number, worldY: number): { x: number; y: number } {
    return projectWorldToNdc(this.camera, orient, worldX, worldY);
  }

  /** Whether any pointer-driven callback is registered (cursor readout or hover). */
  private pointerInterest(): boolean {
    return (
      this.onCursor !== undefined ||
      this.markerHandlers.onMarkerHover !== undefined ||
      this.markerHandlers.markerTooltip !== undefined
    );
  }

  private schedulePointer(): void {
    if (this.destroyed || this.pointerScheduled) return;
    this.pointerScheduled = true;
    this.pointerRaf = requestAnimationFrame(this.pointerFrame);
  }

  /**
   * Topmost marker under a drawing-buffer point, or null. Broad phase: the
   * world-space grid (radius from the largest glyph, dpr-corrected). Narrow phase:
   * the exact screen-space per-glyph test in `pickMarker`. Picking cost scales
   * with candidates near the cursor, which the grid keeps small for typical
   * marker sizes.
   */
  private hitTest(bufX: number, bufY: number): ResolvedMarker | null {
    if (this.markers.count === 0) return null;
    const orient = this.currentOrientation();
    const world = screenToWorld(this.camera, orient, bufX, bufY);
    const radius = broadPhaseWorldRadius(this.markers.maxSize, this.dpr, this.camera.zoom);
    const candidates = this.grid.query(world.x, world.y, radius);
    return pickMarker(candidates, this.markers.list(), this.camera, orient, bufX, bufY, this.dpr);
  }

  /** Once-per-frame: emit the cursor readout and the marker hover/tooltip. */
  private processPointer(): void {
    const p = this.pendingPointer;
    if (p === null) return;
    const orient = this.currentOrientation();
    const world = screenToWorld(this.camera, orient, p.bufX, p.bufY);
    const insideImage =
      world.x >= 0 && world.x < this.nativeW && world.y >= 0 && world.y < this.nativeH;
    let ra: number | null = null;
    let dec: number | null = null;
    if (this.wcs !== null) {
      const sky = pixToSky(this.wcs, world.x, world.y);
      ra = sky.ra;
      dec = sky.dec;
    }
    const marker = this.hitTest(p.bufX, p.bufY);

    this.onCursor?.({ worldX: world.x, worldY: world.y, ra, dec, insideImage, marker });

    // Hover fires only when the topmost marker changes; the popup follows the
    // cursor while a marker stays hovered.
    const id = marker?.id ?? null;
    if (id !== this.hoveredId) {
      this.hoveredId = id;
      this.markerHandlers.onMarkerHover?.(marker === null ? null : this.buildMarkerEvent(marker, p.event));
    }
    const tooltip = this.markerHandlers.markerTooltip;
    if (marker !== null && tooltip !== undefined) {
      const content = tooltip(marker);
      if (content !== null) this.popup.show(content, p.event.clientX, p.event.clientY);
      else this.popup.hide();
    } else {
      this.popup.hide();
    }
  }

  private buildMarkerEvent(marker: ResolvedMarker, e: MouseEvent): MarkerEvent {
    const rect = this.canvas.getBoundingClientRect();
    const cssX = e.clientX - rect.left;
    const cssY = e.clientY - rect.top;
    const bufX = cssX * (this.canvas.width / (rect.width || 1));
    const bufY = cssY * (this.canvas.height / (rect.height || 1));
    const world = screenToWorld(this.camera, this.currentOrientation(), bufX, bufY);
    return { marker, worldX: world.x, worldY: world.y, screenX: cssX, screenY: cssY, originalEvent: e };
  }

  /**
   * Drop any active hover: emit the leave (so a host tracking the hovered marker
   * clears its highlight) and hide the popup. Called on cursor-leave and whenever
   * the hovered marker may have been removed (set/remove/clear) without a pointer
   * move that would otherwise re-evaluate the hover in `processPointer`.
   */
  private clearHoverState(): void {
    if (this.hoveredId !== null) {
      this.hoveredId = null;
      this.markerHandlers.onMarkerHover?.(null);
    }
    this.popup.hide();
  }

  private rebuildGrid(): void {
    this.grid = new GridIndex(this.markers.list());
  }

  private rebuildOverlayBuffer(): void {
    this.overlay.setInstances(packInstances(this.markers.list()), this.markers.count);
  }
}
