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
import { STRETCH_MODE_IDS, type StretchMode } from './stretch.js';
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
  fallbackUV,
  targetLevel,
  tileWorldRect,
  visibleTiles,
  type LevelGeom,
  type WorldRect,
} from './tile-manager.js';

/** Maximum zoom-in: this many drawing-buffer pixels per native pixel. */
const MAX_NATIVE_ZOOM = 16;
/** Drop tiles not drawn for more than this many frames. */
const MAX_IDLE_FRAMES = 60;
/** Default GPU texture budget (tiles). */
const DEFAULT_TEXTURE_BUDGET = 200;
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
  private readonly tiles: TileManager;
  private readonly geoms: Map<number, LevelGeom>;
  private readonly maxLevel: number;
  private readonly nativeW: number;
  private readonly nativeH: number;
  private readonly onFrame?: (info: ViewerFrameInfo) => void;
  private readonly hiDpiLevels: boolean;
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
  private readonly uMode: WebGLUniformLocation | null;
  private readonly uStretchMode: WebGLUniformLocation | null;
  private readonly uUseColormap: WebGLUniformLocation | null;
  private readonly uColormap: WebGLUniformLocation | null;

  private stretchMin = 0;
  private stretchMax = 1;
  private stretchMode: StretchMode = 'linear';
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

  constructor(canvas: HTMLCanvasElement, pyramid: TilePyramid, options: FitsViewerOptions = {}) {
    this.canvas = canvas;
    this.manifest = pyramid.getManifest();
    const [nativeH, nativeW] = this.manifest.native_shape;
    this.nativeW = nativeW;
    this.nativeH = nativeH;
    this.maxLevel = this.manifest.n_levels;
    this.geoms = buildLevelGeoms(this.manifest);
    this.onFrame = options.onFrame;
    this.onCursor = options.onCursor;
    this.hiDpiLevels = options.hiDpiLevels ?? false;

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
    this.uMode = gl.getUniformLocation(this.program, 'u_mode');
    this.uStretchMode = gl.getUniformLocation(this.program, 'u_stretchMode');
    this.uUseColormap = gl.getUniformLocation(this.program, 'u_useColormap');
    this.uColormap = gl.getUniformLocation(this.program, 'u_colormap');

    this.camera = new Camera(Math.max(1, canvas.width), Math.max(1, canvas.height));
    this.tiles = new TileManager(
      gl,
      pyramid,
      this.geoms,
      options.textureBudget ?? DEFAULT_TEXTURE_BUDGET,
      () => this.requestRender(),
    );

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
      this.camera.centerX = c.centerX;
      this.camera.centerY = c.centerY;
      this.lastDragX = p.x;
      this.lastDragY = p.y;
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
      this.camera.centerX = c.centerX;
      this.camera.centerY = c.centerY;
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
    this.camera.centerX = x;
    this.camera.centerY = y;
    this.requestRender();
  }

  setZoom(zoom: number): void {
    this.camera.setZoom(zoom);
    this.requestRender();
  }

  /** Centre the image and zoom so the whole mosaic is visible. */
  fitToImage(): void {
    this.camera.centerX = this.nativeW / 2;
    this.camera.centerY = this.nativeH / 2;
    this.camera.setZoom(this.fitZoom());
    this.requestRender();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.pointerScheduled) cancelAnimationFrame(this.pointerRaf);
    this.detachHandlers();
    this.tiles.destroy();
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

  private draw(): void {
    const gl = this.gl;
    this.frameCounter++;
    this.tiles.frame = this.frameCounter;

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.uniform1i(this.uMode, 0); // single-band (RGB composite is the M4 slot)
    gl.uniform1i(this.uStretchMode, STRETCH_MODE_IDS[this.stretchMode]);
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
    gl.activeTexture(gl.TEXTURE0);

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
    // device-pixel crispness.
    const selectionZoom = this.hiDpiLevels ? this.camera.zoom : this.camera.zoom / this.dpr;
    const level = targetLevel(selectionZoom, this.maxLevel);
    const geom = this.geoms.get(level);
    let visibleTileCount = 0;
    if (geom !== undefined) {
      const tiles = visibleTiles(geom, bounds);
      visibleTileCount = tiles.length;
      for (const t of tiles) {
        const rect = tileWorldRect(geom, t.tileX, t.tileY);
        const entry = this.tiles.acquire(level, t.tileX, t.tileY);
        if (entry !== undefined) {
          this.drawTile(orient, rect, entry.texture, 0, 0, 1, 1);
          continue;
        }
        // Not resident yet: request it, and fill from the best coarser ancestor.
        this.tiles.request(level, t.tileX, t.tileY);
        const fb = coarserFallback(level, t.tileX, t.tileY, this.maxLevel, (l, x, y) =>
          this.tiles.has(l, x, y),
        );
        if (fb !== null) {
          const fbEntry = this.tiles.acquire(fb.level, fb.tileX, fb.tileY);
          const fbGeom = this.geoms.get(fb.level);
          if (fbEntry !== undefined && fbGeom !== undefined) {
            const ancestor = tileWorldRect(fbGeom, fb.tileX, fb.tileY);
            const [u0, v0, u1, v1] = fallbackUV(rect, ancestor);
            this.drawTile(orient, rect, fbEntry.texture, u0, v0, u1, v1);
          }
        }
      }
    }

    this.tiles.evict(MAX_IDLE_FRAMES);

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
    gl.bindTexture(gl.TEXTURE_2D, texture);
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
