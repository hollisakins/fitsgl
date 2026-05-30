/**
 * Phase 3 — WebGL2 viewer public API.
 *
 * `FitsViewer` is the entry point: hand it a canvas and a Phase 2b `TilePyramid`
 * and it renders the mosaic with pan/zoom and linear stretch. The camera and
 * tile-selection helpers are exported for advanced use and testing.
 */

export { FitsViewer } from './viewer.js';
export type { FitsViewerOptions } from './viewer.js';

export { Camera } from './camera.js';
export type { Point, WorldBounds } from './camera.js';

export {
  TileManager,
  targetLevel,
  visibleTiles,
  coarserFallback,
  selectEvictions,
  buildLevelGeoms,
  tileWorldRect,
  tilePixelDims,
  fallbackUV,
  tileKey,
  TILE_SIZE,
} from './tile-manager.js';
export type { TileCoord, WorldRect, LevelGeom, EvictionEntry } from './tile-manager.js';
