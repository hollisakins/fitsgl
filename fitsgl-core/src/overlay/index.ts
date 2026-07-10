/**
 * Overlay module (M3, decision D10) — catalog/region markers over the viewer.
 *
 * Markers are positioned in sky (RA/Dec, ICRS — through the M2 `wcs/` module) or
 * pixels, rendered as instanced WebGL glyphs that share the viewer's oriented
 * transform (so they register under pan/zoom and North-up), and hit-tested on the
 * CPU for hover/click. The pure pieces (marker model, packing, spatial index,
 * hit-test, CSV parsing) unit-test under Node; `overlay-renderer`/`popup` are the
 * thin GL/DOM layer the `FitsViewer` drives.
 */

export {
  MarkerStore,
  MARKER_SHAPES,
  SHAPE_IDS,
  parseColor,
  isMarkerShape,
  resolveMarkerWorld,
  DEFAULT_MARKER_SHAPE,
  DEFAULT_MARKER_SIZE,
  DEFAULT_MARKER_EDGE,
  DEFAULT_MARKER_COLOR,
} from './markers.js';
export type {
  MarkerInput,
  MarkerPatch,
  ResolvedMarker,
  MarkerShape,
  MarkerEvent,
  MarkerHandlers,
  ColorTuple,
  ColorInput,
} from './markers.js';

export { parseCatalogCSV, CATALOG_VERSION } from './catalog.js';

// Pure helpers exposed for advanced hosts/tools (also covered by /internal intent).
export { packInstances, packOne, INSTANCE_FLOATS, INSTANCE_STRIDE_BYTES } from './pack.js';
export { GridIndex } from './spatial-index.js';
export { pickMarker, wasClick, broadPhaseWorldRadius, glyphHalfBuffer, glyphContains } from './hit-test.js';

// GL/DOM layer (used by FitsViewer; exported for embedders building custom views).
export { OverlayRenderer } from './overlay-renderer.js';
export type { OverlayView } from './overlay-renderer.js';
export { OverlayPopup } from './popup.js';

// Region overlays (issue #16) — world-sized, rotatable rect + polygon glyphs.
export {
  RegionStore,
  REGION_SHAPES,
  isRegionShape,
  inferRegionShape,
  resolveRect,
  resolvePolygon,
  DEFAULT_REGION_STROKE,
  DEFAULT_REGION_FILL,
  DEFAULT_REGION_STROKE_WIDTH,
} from './regions.js';
export type {
  RegionInput,
  RegionPatch,
  ResolvedRegion,
  ResolvedRect,
  ResolvedPolygon,
  RegionShape,
  RegionPoint,
  RegionEvent,
  RegionHandlers,
  ResolvedStyle,
} from './regions.js';
export { packRects, packRectOne, REGION_INSTANCE_FLOATS, REGION_INSTANCE_STRIDE_BYTES } from './region-pack.js';
export { triangulate, buildPolygonFill, buildPolygonStroke, signedArea2 } from './polygon.js';
export { pointInRect, pointInPolygon, pointInRegion, pickRegion } from './region-hit-test.js';
export { RegionRenderer } from './region-renderer.js';
