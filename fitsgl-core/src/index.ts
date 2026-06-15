/**
 * @fitsgl/core — browser-side decoder + renderer for fpacked FITS tile pyramids.
 *
 * This is the **narrow public surface** committed to for v1.0 (decision D11): the
 * data layer (`TilePyramid`, manifest, dataset), the renderer (`FitsViewer`,
 * `Camera`, display modes, WCS, overlays), and the `ViewerConfig` every delivery
 * tier consumes. Lower-level building blocks — the RICE/fpack decoders, the worker
 * glue, the tile-selection + grid-match helpers, `TileEngine` — live behind the
 * `@fitsgl/core/internal` subpath: reachable for tools/tests/advanced hosts, but
 * NOT part of the stability contract.
 */

// Manifest
export {
  loadManifest,
  validateManifest,
  resolveLevelUrl,
  resolveSupertile,
  SUPPORTED_MANIFEST_VERSION,
} from './manifest.js';
export type { Manifest, LevelInfo, SupertileInfo, SupertileMatch } from './manifest.js';

// High-level tile access (façade) + a custom-fetch hook for hosts.
export { TilePyramid } from './fpack/tile-source.js';
export type { TilePyramidOptions } from './fpack/tile-source.js';
// `WorkerLike` is already part of the public surface via
// `TilePyramidOptions.workerFactory`; exporting the name lets a bundler host
// type its factory (e.g. a Vite `?worker` constructor) without indexed-access
// gymnastics. A real `Worker` satisfies it with a cast (its `onmessage` takes
// the wider `MessageEvent`), matching the core's own default factory.
export type { WorkerLike } from './fpack/worker-protocol.js';
export { httpRangeFetch } from './fpack/fpack-file.js';
export type { RangeFetcher } from './fpack/fpack-file.js';

// WebGL2 viewer.
export { FitsViewer, Camera } from './renderer/index.js';
export type {
  FitsViewerOptions,
  ViewerFrameInfo,
  CursorInfo,
  AutoStretchResult,
  BandHistogram,
  VisibleHistogram,
  WorldBounds,
  // Read-side state accessors (`getCameraState`/`getDisplayState`) + the pointer
  // tool seam (`setTool`/`PointerTool`) — the Phase-0 foundation for the cursor
  // readout, deep-links, PNG export, the ruler, and split-view locks.
  CameraState,
  DisplayState,
  PointerTool,
  ToolPoint,
} from './renderer/index.js';
// M5 — percentile auto-stretch + visible-data histogram (`FitsViewer.autoStretch`
// and `.visibleHistogram` apply them; `percentileRange`/`histogram` are the pure
// underlying math, for a host computing a stretch/histogram from its own data).
export { percentileRange, histogram, PERCENTILE_SAMPLE_CAP } from './renderer/index.js';
// M4 — render source (single band, three same-grid bands, or N weighted bands).
export type {
  RenderSource,
  SingleBandSource,
  RgbSource,
  MultiBandSource,
  WeightedBand,
} from './renderer/index.js';

// M1 — display modes: stretch curves + bundled colormaps (single-band).
export { STRETCH_MODES, isStretchMode } from './renderer/index.js';
export type { StretchMode } from './renderer/index.js';
// Trilogy stretch: pure level-determination math + precomputed-stats types, plus
// the weighted multi-band helpers (faithful trilogy: per-band stretch + rainbow).
export {
  trilogyCurve,
  solveTrilogyK,
  saturationValue,
  trilogyLevels,
  combineTrilogyLuminance,
  trilogyLevelsForBands,
  rainbowWeights,
  hsvToRgb,
  weightedTrilogyPixel,
  MAX_BANDS,
  DEFAULT_TRILOGY_PARAMS,
  DEFAULT_TRILOGY_K,
} from './renderer/index.js';
export type {
  TrilogyStats,
  TrilogyParams,
  TrilogyLevels,
  TrilogyLuminance,
  BandWeight,
} from './renderer/index.js';
export { COLORMAP_NAMES, COLORMAP_SIZE, isColormapName, colormapRGB } from './renderer/index.js';
export type { ColormapName, ColormapLUT } from './renderer/index.js';

// M2 — WCS: client-side TAN pixel<->sky (ICRS) + sexagesimal formatting.
export { parseWcs, pixToSky, skyToPix, formatRA, formatDec } from './wcs/index.js';
export type { TanWcs, SkyCoord, PixelCoord } from './wcs/index.js';

// M4 — dataset manifest: groups composite-compatible single-band pyramids. The
// authoritative same-grid gate (`gridsMatch`/`GridSpec`) is an internal detail;
// `compatibleBands` is the host-facing helper a band picker uses.
export {
  loadDataset,
  validateDataset,
  resolveDatasetBandUrl,
  compatibleBands,
  DATASET_VERSION,
} from './dataset.js';
export type { DatasetManifest, DatasetBand, DatasetRgbRoles } from './dataset.js';

// M3 — overlays: catalog/region markers (sky or pixel), instanced WebGL render +
// CPU hit-testing + one reused DOM popup (decision D10).
export {
  MARKER_SHAPES,
  isMarkerShape,
  parseColor,
  parseCatalogCSV,
  CATALOG_VERSION,
} from './overlay/index.js';
export type {
  MarkerInput,
  MarkerPatch,
  ResolvedMarker,
  MarkerShape,
  MarkerEvent,
  MarkerHandlers,
  ColorInput,
  ColorTuple,
} from './overlay/index.js';

// M5 — ViewerConfig: the single high-level config every delivery tier (React,
// vanilla embed, SSG) consumes. `loadViewerSource` does the URL->RenderSource
// orchestration that used to live in the demo. The view/stretch fields reference
// `StretchMode`/`ColormapName` (exported above). A band's `tiles` list is length 1
// today; length N is the M6 tiled-mosaic case (decisions D13/D14).
export {
  validateViewerConfig,
  renderSourceForView,
  loadViewerSource,
} from './viewer-config.js';
export type {
  ViewerConfig,
  BandConfig,
  StretchRange,
  ViewerStretchConfig,
  ViewerView,
  WeightedBandView,
  OverlaySource,
  LoadedViewerSource,
} from './viewer-config.js';

// The producer contract (`fitsgl.json`): the dataset inventory + an overridable
// default view, sitting above `ViewerConfig`. `loadFitsglConfig` fetches +
// validates + resolves relative URLs against the config URL (the cross-origin fix);
// `fitsglConfigFromDataset` bridges a legacy `dataset.json` until `fitsgl build`
// emits `fitsgl.json`.
export {
  validateFitsglConfig,
  resolveFitsglConfig,
  loadFitsglConfig,
  fitsglConfigFromDataset,
  FITSGL_SCHEMA_VERSION,
} from './fitsgl-config.js';
export type {
  FitsglConfig,
  FitsglDataset,
  FitsglBand,
  FitsglBandStats,
  FitsglDefaultView,
} from './fitsgl-config.js';

// The collection contract (`collection.json`): the multi-field landing-page index
// emitted at the deploy root, sibling of `fitsgl.json`. The viewer probes it to
// render a field picker; `fitsgl index` (the producer CLI) emits it.
export { validateCollection, loadCollection, COLLECTION_SCHEMA_VERSION } from './collection.js';
export type { Collection, CollectionField } from './collection.js';
