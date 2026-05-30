/**
 * Phase 3 — WebGL2 viewer public API.
 *
 * `FitsViewer` is the entry point: hand it a canvas and a Phase 2b `TilePyramid`
 * and it renders the mosaic with pan/zoom and linear stretch. The camera and
 * tile-selection helpers are exported for advanced use and testing.
 */

export { FitsViewer } from './viewer.js';
export type { FitsViewerOptions, ViewerFrameInfo, CursorInfo } from './viewer.js';

export { Camera } from './camera.js';
export type { Point, WorldBounds } from './camera.js';

// Display modes (M1): stretch curves + bundled colormaps for single-band view.
export { STRETCH_MODES, isStretchMode } from './stretch.js';
export type { StretchMode } from './stretch.js';
export { COLORMAP_NAMES, COLORMAP_SIZE, isColormapName, colormapRGB } from './colormaps.js';
export type { ColormapName, ColormapLUT } from './colormaps.js';

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
