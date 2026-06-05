/**
 * Tile selection math + GPU texture management.
 *
 * The selection logic is a set of pure functions (`targetLevel`,
 * `visibleTiles`, `coarserFallback`, `selectEvictions`, the geometry helpers) so
 * they can be unit-tested in Node without a GL context. The `TileManager` class
 * wires those together with the actual `WebGL2RenderingContext` and the
 * `TilePyramid`: it requests decoded `Float32Array` tiles, uploads them as R32F
 * textures, tracks last-visible frame for LRU eviction, and dedupes in-flight
 * requests.
 *
 * Level/zoom convention (matches the Phase 1 pyramid and the manifest): z=0 is
 * native resolution; each step up in z halves resolution. A tile (z, tx, ty)
 * covers `256 * 2^z` world (native) pixels per side starting at
 * `(tx, ty) * 256 * 2^z`, except high-index edge tiles, which are smaller when
 * the level's pixel dimensions are not a multiple of 256.
 */

import type { Manifest } from '../manifest.js';
import { isAbortError, type TilePyramid } from '../fpack/tile-source.js';
import type { WorldBounds } from './camera.js';
import { createTileTexture } from './gl-util.js';

/** fpack-internal tile edge, in level pixels (every pyramid level uses 256). */
export const TILE_SIZE = 256;

export interface TileCoord {
  level: number;
  tileX: number;
  tileY: number;
}

export interface WorldRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Per-level geometry needed for tile<->world math. */
export interface LevelGeom {
  z: number;
  /** Level image dimensions in level pixels. */
  levelW: number;
  levelH: number;
  /** Tile counts along each axis. */
  nTilesX: number;
  nTilesY: number;
}

/** Stable cache key for a tile, matching the engine's `level/x/y` form. */
export function tileKey(level: number, tileX: number, tileY: number): string {
  return `${level}/${tileX}/${tileY}`;
}

/** Build a z -> LevelGeom map from the manifest's per-level shape/tile counts. */
export function buildLevelGeoms(manifest: Manifest): Map<number, LevelGeom> {
  const map = new Map<number, LevelGeom>();
  for (const lvl of manifest.levels) {
    const [levelH, levelW] = lvl.shape;
    const [nTilesY, nTilesX] = lvl.fpack_tile_count;
    map.set(lvl.z, { z: lvl.z, levelW, levelH, nTilesX, nTilesY });
  }
  return map;
}

/**
 * Pixel dimensions of a single tile, accounting for partial high-index edge
 * tiles (astropy stores those at their true smaller size).
 */
export function tilePixelDims(
  geom: LevelGeom,
  tileX: number,
  tileY: number,
): { width: number; height: number } {
  return {
    width: Math.min(TILE_SIZE, geom.levelW - tileX * TILE_SIZE),
    height: Math.min(TILE_SIZE, geom.levelH - tileY * TILE_SIZE),
  };
}

/** World-space rectangle covered by a tile (native pixels). */
export function tileWorldRect(
  geom: LevelGeom,
  tileX: number,
  tileY: number,
): WorldRect {
  const f = 2 ** geom.z;
  const px1 = Math.min((tileX + 1) * TILE_SIZE, geom.levelW);
  const py1 = Math.min((tileY + 1) * TILE_SIZE, geom.levelH);
  return {
    x0: tileX * TILE_SIZE * f,
    y0: tileY * TILE_SIZE * f,
    x1: px1 * f,
    y1: py1 * f,
  };
}

/**
 * Pick the pyramid level whose one tile-pixel maps to about one screen pixel:
 * `2^z ≈ 1 / zoom`. Rounded to the nearest level and clamped to [0, maxLevel].
 */
export function targetLevel(zoom: number, maxLevel: number): number {
  if (!(zoom > 0)) return maxLevel;
  const z = Math.round(-Math.log2(zoom));
  return Math.max(0, Math.min(maxLevel, z));
}

/**
 * Choose the pyramid level to DISPLAY this frame, deferring level switches until
 * interaction settles (the behaviour CARTA gets from debouncing tile requests).
 *
 * Block-averaged coarser levels genuinely carry less noise (σ drops by 2× per
 * level), so switching levels live mid-gesture makes the displayed noise visibly
 * melt down as the user zooms — jarring. Instead, during an active gesture
 * (`idle` false) we keep the previously-settled `held` level: the camera
 * transform just resamples the resident textures (NEAREST), so the noise level
 * stays put — decimated on zoom-out, blocky on zoom-in — until motion stops. On
 * settle (`idle` true), with deferral off, or before any level has been held, the
 * freshly-computed `live` level is adopted (and becomes the new held level), so
 * the correct resolution loads and crossfades in once.
 *
 * The held level is clamped to `[0, maxLevel]` so a value that outlived a change
 * in pyramid depth can never select a missing geom.
 */
export function resolveDisplayLevel(
  live: number,
  held: number | null,
  idle: boolean,
  defer: boolean,
  maxLevel: number,
): { level: number; held: number } {
  if (defer && !idle && held !== null) {
    const clamped = Math.max(0, Math.min(held, maxLevel));
    return { level: clamped, held: clamped };
  }
  return { level: live, held: live };
}

/**
 * Tiles at `level` whose world rectangles intersect the viewport bounds.
 * Returns an empty array if the viewport does not overlap the level's imaged
 * area at all. Tiles are returned in row-major order (y outer, x inner).
 */
export function visibleTiles(geom: LevelGeom, bounds: WorldBounds): TileCoord[] {
  const f = 2 ** geom.z;
  const span = TILE_SIZE * f; // world pixels per full tile
  const worldW = geom.levelW * f;
  const worldH = geom.levelH * f;

  // Intersect the (possibly inverted/negative) viewport with the imaged area.
  const minX = Math.max(0, Math.min(bounds.x0, bounds.x1));
  const maxX = Math.min(worldW, Math.max(bounds.x0, bounds.x1));
  const minY = Math.max(0, Math.min(bounds.y0, bounds.y1));
  const maxY = Math.min(worldH, Math.max(bounds.y0, bounds.y1));
  if (maxX <= minX || maxY <= minY) return [];

  const tx0 = Math.max(0, Math.floor(minX / span));
  // maxX is an exclusive edge; nudge inward so a viewport ending exactly on a
  // tile boundary does not pull in the next (empty) tile column.
  const tx1 = Math.min(geom.nTilesX - 1, Math.floor((maxX - 1e-6) / span));
  const ty0 = Math.max(0, Math.floor(minY / span));
  const ty1 = Math.min(geom.nTilesY - 1, Math.floor((maxY - 1e-6) / span));

  const tiles: TileCoord[] = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      tiles.push({ level: geom.z, tileX: tx, tileY: ty });
    }
  }
  return tiles;
}

/**
 * Tiles in a `margin`-tile band just outside the viewport (the visible tiles are
 * excluded) — the prefetch ring, so a pan reveals already-loading tiles instead
 * of a cold edge. Same intersection + edge-nudge math as `visibleTiles`, then the
 * tile box is grown by `margin` on each side and the visible box subtracted.
 * Returns `[]` for `margin <= 0` or when the viewport does not overlap the level.
 */
export function ringTiles(geom: LevelGeom, bounds: WorldBounds, margin: number): TileCoord[] {
  if (margin <= 0) return [];
  const f = 2 ** geom.z;
  const span = TILE_SIZE * f;
  const worldW = geom.levelW * f;
  const worldH = geom.levelH * f;

  const minX = Math.max(0, Math.min(bounds.x0, bounds.x1));
  const maxX = Math.min(worldW, Math.max(bounds.x0, bounds.x1));
  const minY = Math.max(0, Math.min(bounds.y0, bounds.y1));
  const maxY = Math.min(worldH, Math.max(bounds.y0, bounds.y1));
  if (maxX <= minX || maxY <= minY) return [];

  const vtx0 = Math.max(0, Math.floor(minX / span));
  const vtx1 = Math.min(geom.nTilesX - 1, Math.floor((maxX - 1e-6) / span));
  const vty0 = Math.max(0, Math.floor(minY / span));
  const vty1 = Math.min(geom.nTilesY - 1, Math.floor((maxY - 1e-6) / span));

  const tx0 = Math.max(0, vtx0 - margin);
  const tx1 = Math.min(geom.nTilesX - 1, vtx1 + margin);
  const ty0 = Math.max(0, vty0 - margin);
  const ty1 = Math.min(geom.nTilesY - 1, vty1 + margin);

  const tiles: TileCoord[] = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      if (tx >= vtx0 && tx <= vtx1 && ty >= vty0 && ty <= vty1) continue; // visible: skip
      tiles.push({ level: geom.z, tileX: tx, tileY: ty });
    }
  }
  return tiles;
}

/**
 * Every tile of a level, row-major (y outer, x inner). Used to pin the fit-level
 * "floor" grid — the coarsest level the viewer ever displays — so the zoom-out
 * fallback never drops below fit-to-window resolution (and a cold open paints at
 * fit resolution directly instead of the 1-tile whole-image blur). It enumerates
 * EVERY tile of the level across the whole mosaic — but the caller picks the floor
 * LEVEL to roughly match the fit-to-window resolution, so the level's pixel
 * dimensions (and hence its full tile count) are on the order of the viewport, not
 * the mosaic's native size; the count scales with the window/DPR via that choice.
 */
export function allLevelTiles(geom: LevelGeom): TileCoord[] {
  const tiles: TileCoord[] = [];
  for (let ty = 0; ty < geom.nTilesY; ty++) {
    for (let tx = 0; tx < geom.nTilesX; tx++) {
      tiles.push({ level: geom.z, tileX: tx, tileY: ty });
    }
  }
  return tiles;
}

/**
 * Reorder visible tiles center-out: nearest to the world point `(cx, cy)` first,
 * so the area the user is looking at sharpens before the periphery (CARTA orders
 * every request batch by squared distance to its view focus point). Pure; returns
 * a new array sorted by the squared distance from each tile's world-rect centre to
 * `(cx, cy)`. A stable, allocation-light comparator — the per-tile distance is
 * recomputed in the comparator, which is fine for the handful of visible tiles.
 */
export function centerOutOrder(
  tiles: readonly TileCoord[],
  geom: LevelGeom,
  cx: number,
  cy: number,
): TileCoord[] {
  const dist2 = (t: TileCoord): number => {
    const r = tileWorldRect(geom, t.tileX, t.tileY);
    const mx = (r.x0 + r.x1) / 2 - cx;
    const my = (r.y0 + r.y1) / 2 - cy;
    return mx * mx + my * my;
  };
  return [...tiles].sort((a, b) => dist2(a) - dist2(b));
}

/**
 * Find the finest loaded coarser ancestor of a tile for progressive-refinement
 * fallback while the target tile is still loading. Walks up one level at a time
 * (each level halves the tile index) and returns the first ancestor for which
 * `isLoaded` is true, or null if none up to `maxLevel` is available.
 */
export function coarserFallback(
  level: number,
  tileX: number,
  tileY: number,
  maxLevel: number,
  isLoaded: (level: number, tileX: number, tileY: number) => boolean,
): TileCoord | null {
  for (let cl = level + 1; cl <= maxLevel; cl++) {
    const k = cl - level;
    const ctx = Math.floor(tileX / 2 ** k);
    const cty = Math.floor(tileY / 2 ** k);
    if (isLoaded(cl, ctx, cty)) return { level: cl, tileX: ctx, tileY: cty };
  }
  return null;
}

/**
 * Finest pyramid level `cl >= level` at which the tile (or its shared ancestor)
 * is resident in EVERY composite band — for RGB compositing (decision D7).
 *
 * The tile vertex shader exposes a single `u_uv`/`v_uv`, so all three channels
 * must be sampled from the same source level + sub-rectangle in one draw call;
 * registration is guaranteed only when the three bands draw from a COMMON level.
 * Unlike `coarserFallback` (which starts at `level + 1` because the single-band
 * path checks the target level itself separately), this INCLUDES `cl = level` by
 * default — the common, fully-loaded steady state — then walks up one level at a
 * time (each step halves the tile index). Pass `fromLevel = level + 1` to start
 * strictly coarser (used when the target level is already handled, e.g. as a
 * crossfade base that must differ from the target). `hasAll(level, tileX, tileY)`
 * must report whether *every* band has that tile resident. Returns the common
 * level and its ancestor tile index, or null if no level up to `maxLevel` is
 * common to all.
 */
export function commonResidentLevel(
  level: number,
  tileX: number,
  tileY: number,
  maxLevel: number,
  hasAll: (level: number, tileX: number, tileY: number) => boolean,
  fromLevel: number = level,
): TileCoord | null {
  for (let cl = fromLevel; cl <= maxLevel; cl++) {
    const k = cl - level;
    const ctx = Math.floor(tileX / 2 ** k);
    const cty = Math.floor(tileY / 2 ** k);
    if (hasAll(cl, ctx, cty)) return { level: cl, tileX: ctx, tileY: cty };
  }
  return null;
}

/** A finer level plus the descendant tiles of a target that are resident there. */
export interface FinerCoverage {
  level: number;
  /** Resident descendant tiles at `level` — a SUBSET of the 2ᵏ×2ᵏ block (partial). */
  tiles: TileCoord[];
}

/**
 * Finer-level fallback (the zoom-OUT counterpart of `coarserFallback`). When a
 * target tile is not yet resident, the FINER level the user just left is often
 * still GPU-resident and covers the same world area at higher resolution — far
 * better than upscaling a coarse ancestor. Walks DOWN from `level - 1` toward 0
 * and returns the NEAREST finer level that has ANY resident descendant of the
 * target, together with the subset of its 2ᵏ×2ᵏ descendant block that is resident.
 *
 * Coverage is deliberately PARTIAL: the caller draws a coarse ancestor as a base
 * first (always hole-free, thanks to the pinned coarsest tile) and then overlays
 * these finer tiles on top, so the screen shows sharp detail wherever the finer
 * level loaded and falls back to coarse only in the real gaps. Requiring *full*
 * coverage instead is brittle — at the viewport periphery and during fast or
 * multi-level zoom-outs the finer block is rarely complete, which would drop the
 * whole tile to a coarse upscale (the "big blocks" flash) AND leave the finer
 * tiles un-acquired, so they evict out from under the next frame. The caller must
 * `acquire` the returned tiles (mark them visible) to keep the level resident.
 * Reuses no fetches: it only consults what is already resident.
 */
export function finerFallback(
  level: number,
  tileX: number,
  tileY: number,
  isLoaded: (level: number, tileX: number, tileY: number) => boolean,
): FinerCoverage | null {
  for (let fl = level - 1; fl >= 0; fl--) {
    const n = 2 ** (level - fl);
    const bx = tileX * n;
    const by = tileY * n;
    const tiles: TileCoord[] = [];
    for (let dy = 0; dy < n; dy++) {
      for (let dx = 0; dx < n; dx++) {
        const x = bx + dx;
        const y = by + dy;
        if (isLoaded(fl, x, y)) tiles.push({ level: fl, tileX: x, tileY: y });
      }
    }
    if (tiles.length > 0) return { level: fl, tiles };
  }
  return null;
}

/**
 * UV sub-rectangle of an ancestor tile's texture that corresponds to a
 * (smaller) descendant tile's world rectangle. Used to draw a coarse tile into
 * a fine tile's screen area. (0,0) = top-left of the texture, matching the
 * non-flipped upload in `createTileTexture`.
 */
export function fallbackUV(target: WorldRect, ancestor: WorldRect): [number, number, number, number] {
  const aw = ancestor.x1 - ancestor.x0;
  const ah = ancestor.y1 - ancestor.y0;
  // The pyramid is built by independent per-level block-reduce with remainder
  // trimming, so a fine level's imaged area can extend a few native pixels past a
  // coarser ancestor's at the high edge — making (target.x1 - ancestor.x0)/aw
  // slightly exceed 1. Clamp so the sub-rect stays inside the ancestor texture.
  const clamp01 = (t: number): number => Math.min(1, Math.max(0, t));
  return [
    clamp01((target.x0 - ancestor.x0) / aw),
    clamp01((target.y0 - ancestor.y0) / ah),
    clamp01((target.x1 - ancestor.x0) / aw),
    clamp01((target.y1 - ancestor.y0) / ah),
  ];
}

export interface EvictionEntry {
  key: string;
  lastVisibleFrame: number;
}

/**
 * Pure eviction policy. A tile is dropped if it has not been visible for more
 * than `maxIdle` frames; on top of that, if more than `budget` tiles remain,
 * the least-recently-visible survivors are dropped until the budget is met.
 * Tiles visible on the *current* frame are never budget-evicted — otherwise a
 * viewport needing more than `budget` tiles would drop tiles it just drew and
 * re-upload them next frame (thrash/flicker); the budget is allowed to be
 * temporarily exceeded instead. Returns the keys to evict.
 */
export function selectEvictions(
  entries: EvictionEntry[],
  budget: number,
  frame: number,
  maxIdle: number,
): string[] {
  const evict = new Set<string>();
  for (const e of entries) {
    if (frame - e.lastVisibleFrame > maxIdle) evict.add(e.key);
  }
  let count = entries.length - evict.size; // resident after idle eviction
  const candidates = entries
    .filter((e) => !evict.has(e.key) && e.lastVisibleFrame !== frame)
    .sort((a, b) => a.lastVisibleFrame - b.lastVisibleFrame); // oldest first
  for (let i = 0; count > budget && i < candidates.length; i++) {
    evict.add(candidates[i].key);
    count--;
  }
  return [...evict];
}

interface TileTexture {
  texture: WebGLTexture;
  width: number;
  height: number;
  lastVisibleFrame: number;
  /** Wall-clock ms when the tile was uploaded — drives the crossfade-in ramp. */
  uploadedAt: number;
}

/**
 * Owns the GPU-side tile textures: requests decoded tiles from the pyramid,
 * uploads them, tracks visibility for eviction, and dedupes concurrent
 * requests. The selection math above does the deciding; this class does the IO
 * and GL side effects.
 */
export class TileManager {
  private readonly textures = new Map<string, TileTexture>();
  private readonly inflight = new Set<string>();
  /** Tile keys whose level file+index has been speculatively warmed (`warmLevel`),
   *  so the warm fires once per supertile rather than every idle frame. */
  private readonly warmed = new Set<string>();
  /**
   * In-flight FETCH-phase requests (not yet decoded): their abort controller +
   * level, so `cancelExcept` can abort tiles that scrolled out of the retention
   * region before loading. A tile leaves this map once decoded (it moves to
   * `pendingUploads`) — decoded work can't be unspent, so it isn't cancellable.
   */
  private readonly fetches = new Map<string, { controller: AbortController; level: number }>();
  /**
   * Decoded tiles awaiting GPU upload. The upload (texImage2D) is deferred out of
   * the fetch/decode callback into `flushUploads`, which the viewer calls with a
   * per-frame budget — so a burst of tiles decoded in parallel (or served fast
   * from the disk cache on a warm reload) can't stall the frame with many uploads
   * at once. A queued tile stays in `inflight` so it is not re-requested.
   */
  private readonly pendingUploads: Array<{
    key: string;
    data: Float32Array;
    width: number;
    height: number;
  }> = [];
  /** Current render frame, set by the viewer at the start of each draw. */
  frame = 0;
  private destroyed = false;
  /**
   * Per-band GPU texture budget (max resident tiles before LRU eviction kicks in).
   * Mutable because the viewer raises it to cover the pinned fit-level floor grid,
   * whose size tracks the window — so the working-set headroom stays constant as
   * the floor grows on a larger display.
   */
  budget: number;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly pyramid: TilePyramid,
    private readonly geoms: Map<number, LevelGeom>,
    budget: number,
    private readonly onTileLoaded: () => void,
  ) {
    this.budget = budget;
  }

  has(level: number, tileX: number, tileY: number): boolean {
    return this.textures.has(tileKey(level, tileX, tileY));
  }

  /** Texture for a tile, marking it visible this frame, or undefined if absent. */
  acquire(level: number, tileX: number, tileY: number): TileTexture | undefined {
    const entry = this.textures.get(tileKey(level, tileX, tileY));
    if (entry !== undefined) entry.lastVisibleFrame = this.frame;
    return entry;
  }

  /**
   * Speculatively warm a level's file + tile index (no tile fetch/decode), so a
   * later `request` at that level pays only the tile-bytes round trip instead of
   * the file-open + index-parse round trips on top — used to hide the per-level
   * first-touch cliff for an anticipated zoom-in. Deduped per tile key so it fires
   * once per supertile; on failure the key is cleared so a later idle frame can
   * retry. One warmed tile covers the whole level index for its supertile.
   */
  warmLevel(level: number, tileX: number, tileY: number): void {
    const key = tileKey(level, tileX, tileY);
    if (this.warmed.has(key) || this.textures.has(key) || this.inflight.has(key)) return;
    this.warmed.add(key);
    this.pyramid.prefetchTileIndex(level, tileX, tileY).catch(() => {
      this.warmed.delete(key);
    });
  }

  /** Kick off loading a tile if not already resident or in flight. */
  request(level: number, tileX: number, tileY: number): void {
    const key = tileKey(level, tileX, tileY);
    if (this.textures.has(key) || this.inflight.has(key)) return;
    const geom = this.geoms.get(level);
    if (geom === undefined) return;
    this.inflight.add(key);
    const controller = new AbortController();
    this.fetches.set(key, { controller, level });
    this.pyramid
      .getTile(level, tileX, tileY, controller.signal)
      .then((data) => {
        this.fetches.delete(key); // left the fetch phase
        // Torn down, or cancelled after the fetch resolved: drop it rather than
        // upload a tile the user has panned away from.
        if (this.destroyed || controller.signal.aborted) {
          this.inflight.delete(key);
          return;
        }
        const { width, height } = tilePixelDims(geom, tileX, tileY);
        // Tile dims are derived from the manifest's 256-px tiling; if the decoded
        // length disagrees (e.g. a pyramid with a non-256 fpack tile size), the
        // R32F upload would be undersized and sample as opaque black. Skip with a
        // warning rather than render a wrong tile.
        if (data.length !== width * height) {
          console.warn(
            `TileManager: tile ${key} decoded length ${data.length} != ${width}×${height}; skipping upload`,
          );
          this.inflight.delete(key);
          return;
        }
        // Defer the GPU upload to flushUploads (frame-budgeted). The key stays in
        // `inflight` until uploaded so it is not re-requested while it waits.
        this.pendingUploads.push({ key, data, width, height });
        this.onTileLoaded();
      })
      .catch((err: unknown) => {
        this.fetches.delete(key);
        this.inflight.delete(key);
        // A cancelled fetch (pan-away) is expected, not a failure — stay quiet.
        if (this.destroyed || isAbortError(err)) return;
        console.warn(`TileManager: failed to load tile ${key}:`, err);
      });
  }

  /**
   * Abort in-flight FETCHES at `level` whose key is not in `retain` — tiles that
   * scrolled out of the viewport + prefetch ring before they finished loading.
   * Only fetch-phase tiles at the current level are cancelled; already-decoded
   * tiles and tiles at other levels (coarse fallbacks, the coarsest prime) are
   * left untouched. The aborted requests clean themselves up in their `.catch`.
   */
  cancelExcept(level: number, retain: Set<string>): void {
    for (const [key, f] of this.fetches) {
      if (f.level === level && !retain.has(key)) f.controller.abort();
    }
  }

  /**
   * Upload up to `budget` queued tiles to the GPU (marking them resident this
   * frame) and return the number still queued. The viewer calls this once per
   * frame; when the return is > 0 it schedules another frame to drain the rest.
   */
  flushUploads(budget: number, now = 0): number {
    if (this.destroyed) return 0;
    let uploaded = 0;
    while (uploaded < budget && this.pendingUploads.length > 0) {
      const u = this.pendingUploads.shift()!;
      this.inflight.delete(u.key);
      const texture = createTileTexture(this.gl, u.width, u.height, u.data);
      this.textures.set(u.key, {
        texture,
        width: u.width,
        height: u.height,
        lastVisibleFrame: this.frame,
        uploadedAt: now,
      });
      uploaded++;
    }
    return this.pendingUploads.length;
  }

  /** Evict textures no longer needed, per `selectEvictions`. */
  evict(maxIdle: number): void {
    if (this.textures.size === 0) return;
    const entries: EvictionEntry[] = [];
    for (const [key, t] of this.textures) {
      entries.push({ key, lastVisibleFrame: t.lastVisibleFrame });
    }
    for (const key of selectEvictions(entries, this.budget, this.frame, maxIdle)) {
      const t = this.textures.get(key);
      if (t !== undefined) {
        this.gl.deleteTexture(t.texture);
        this.textures.delete(key);
      }
    }
  }

  /** Number of resident textures (diagnostics/tests). */
  get residentCount(): number {
    return this.textures.size;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const f of this.fetches.values()) f.controller.abort();
    this.fetches.clear();
    for (const t of this.textures.values()) this.gl.deleteTexture(t.texture);
    this.textures.clear();
    this.inflight.clear();
    this.warmed.clear();
    this.pendingUploads.length = 0;
  }
}
