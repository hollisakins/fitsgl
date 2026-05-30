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

  private readonly uRect: WebGLUniformLocation | null;
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
  private readonly onMouseUp: () => void;
  private readonly onWheel: (e: WheelEvent) => void;
  private readonly frame: () => void;

  constructor(canvas: HTMLCanvasElement, pyramid: TilePyramid, options: FitsViewerOptions = {}) {
    this.canvas = canvas;
    this.manifest = pyramid.getManifest();
    const [nativeH, nativeW] = this.manifest.native_shape;
    this.nativeW = nativeW;
    this.nativeH = nativeH;
    this.maxLevel = this.manifest.n_levels;
    this.geoms = buildLevelGeoms(this.manifest);
    this.onFrame = options.onFrame;
    this.hiDpiLevels = options.hiDpiLevels ?? false;

    const gl = canvas.getContext('webgl2');
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
    this.uRect = gl.getUniformLocation(this.program, 'u_rect');
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

    gl.clearColor(0, 0, 0, 1);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    this.frame = () => {
      this.renderScheduled = false;
      if (!this.destroyed) this.draw();
    };

    this.onMouseDown = (e) => {
      if (e.button !== 0) return;
      this.dragging = true;
      const p = this.toBufferCoords(e);
      this.lastDragX = p.x;
      this.lastDragY = p.y;
    };
    this.onMouseMove = (e) => {
      if (!this.dragging) return;
      const p = this.toBufferCoords(e);
      this.camera.panByScreen(p.x - this.lastDragX, p.y - this.lastDragY);
      this.lastDragX = p.x;
      this.lastDragY = p.y;
      this.requestRender();
    };
    this.onMouseUp = () => {
      this.dragging = false;
    };
    this.onWheel = (e) => {
      e.preventDefault();
      const p = this.toBufferCoords(e);
      const factor = Math.pow(2, -e.deltaY * WHEEL_ZOOM_RATE);
      this.camera.zoomAt(p.x, p.y, this.camera.zoom * factor);
      this.requestRender();
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
    this.detachHandlers();
    this.tiles.destroy();
    this.clearColormapTexture();
    this.gl.deleteProgram(this.program);
    this.gl.deleteVertexArray(this.vao);
    this.gl.deleteBuffer(this.quadBuffer); // deleteVertexArray does not free it
    // The pyramid is caller-owned and intentionally not destroyed here.
  }

  // ---- sizing / zoom limits ----------------------------------------------

  /** Smallest zoom that still fits the whole image in the viewport. */
  private fitZoom(): number {
    return Math.min(
      this.camera.viewportWidth / this.nativeW,
      this.camera.viewportHeight / this.nativeH,
    );
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
    // Out to "whole mosaic visible", in to MAX_NATIVE_ZOOM native pixels — but
    // never cap below the fit zoom, so a mosaic smaller than the viewport (where
    // the fit zoom exceeds 16×) still fits instead of pinning at the 16× ceiling.
    this.camera.setZoomLimits(this.fitZoom(), Math.max(this.fitZoom(), MAX_NATIVE_ZOOM * dpr));
  }

  // ---- event wiring -------------------------------------------------------

  private attachHandlers(): void {
    this.canvas.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mouseup', this.onMouseUp);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
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

    const bounds = this.camera.worldBounds();
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
          this.drawTile(rect, entry.texture, 0, 0, 1, 1);
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
            this.drawTile(rect, fbEntry.texture, u0, v0, u1, v1);
          }
        }
      }
    }

    this.tiles.evict(MAX_IDLE_FRAMES);

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
        });
      } catch (err) {
        // A telemetry callback must never be able to stop the render loop.
        console.error('FitsViewer: onFrame callback threw:', err);
      }
    }
  }

  /** Draw a world rectangle textured by `texture` over the [u0,v0]-[u1,v1] sub-rect. */
  private drawTile(
    rect: WorldRect,
    texture: WebGLTexture,
    u0: number,
    v0: number,
    u1: number,
    v1: number,
  ): void {
    const gl = this.gl;
    const tl = this.camera.worldToScreen(rect.x0, rect.y0);
    const br = this.camera.worldToScreen(rect.x1, rect.y1);
    const w = this.canvas.width;
    const h = this.canvas.height;
    // Screen (y-down) -> NDC (y-up).
    const nx0 = (tl.x / w) * 2 - 1;
    const nx1 = (br.x / w) * 2 - 1;
    const ny0 = 1 - (tl.y / h) * 2;
    const ny1 = 1 - (br.y / h) * 2;
    gl.uniform4f(this.uRect, nx0, ny0, nx1, ny1);
    gl.uniform4f(this.uUV, u0, v0, u1, v1);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
