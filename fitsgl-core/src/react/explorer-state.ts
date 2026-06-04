/**
 * Pure view-state logic for `<FitsExplorer>` — no React, no GL, no DOM, so it
 * unit-tests under Node (the repo's pure-logic / side-effect split).
 *
 * `<FitsExplorer>` is the batteries-included tier: it owns the interactive view
 * state (which band(s) are shown, the R/G/B assignment, stretch, colormap,
 * north-up) and derives the `ViewerConfig` the controlled `<FitsViewer>` consumes.
 * This module is the decision layer behind it:
 *
 *  - the **dataset is pure inventory** (bands + where they live + a grid group);
 *    RGB role assignment is *view state* a user changes live, never a data fact.
 *  - RGB compositing is the one operation constrained by grid: bands carry a
 *    `gridGroup`, and the picker offers an RGB channel a band only within the
 *    active group (cross-grid filters grey out). The authoritative gate stays the
 *    renderer's `gridsMatch` at composite time — `gridGroup` is the advisory hint
 *    the UI greys by, exactly as the producer's build emits it.
 */

import {
  fitsglConfigFromDataset,
  DEFAULT_TRILOGY_PARAMS,
  type ColormapName,
  type DatasetManifest,
  type FitsglConfig,
  type StretchMode,
  type TrilogyParams,
  type TrilogyStats,
  type ViewerConfig,
  type ViewerView,
} from '../index.js';

/** One band in the explorer's inventory: a name + where its pyramid lives + grid. */
export interface ExplorerBand {
  /** Stable key the view references. */
  name: string;
  /** Manifest URL(s) for the band's pyramid(s); length 1 today (M6 = N). */
  tiles: string[];
  /** Display label; defaults to `name`. */
  label?: string;
  /**
   * Co-gridded grouping id. Bands sharing it can be RGB-composited; the picker
   * greys cross-group bands. Defaults to 0 (a single-grid dataset = one group).
   */
  gridGroup?: number;
  /** Native pixel scale, for a scale-bar / label. */
  pixelScaleArcsec?: number;
  /** Pre-computed display histogram (wire shape) seeding the stretch panel so it
   *  need not scan live; counts per bin over `[lo, hi]`. Omitted ⇒ scan on first frame. */
  histogram?: { counts: number[]; lo: number; hi: number };
  /** Pre-computed global trilogy stats (native z=0); drives a stable, color-preserving
   *  trilogy stretch with no live rescan. Omitted ⇒ trilogy falls back to a percentile fit. */
  trilogy?: TrilogyStats;
}

/** The producer's default view (from `[viewer]` / `defaultView`). All overridable. */
export interface ExplorerDefaultView {
  mode?: 'single' | 'rgb';
  band?: string;
  r?: string;
  g?: string;
  b?: string;
  stretch?: StretchMode;
  colormap?: ColormapName;
  northUp?: boolean;
}

/** The live, user-mutable view state the component holds. */
export interface ExplorerState {
  mode: 'single' | 'rgb';
  /** Single-band selection. */
  band: string;
  /** RGB channel assignment (always populated within one grid group). */
  rgb: { r: string; g: string; b: string };
  stretch: StretchMode;
  /** Trilogy knobs (noiselum/satpercent/noisesig/noisesig0), used when `stretch` is `trilogy`. */
  trilogyParams: TrilogyParams;
  /** Single-band colormap (`'gray'` is the grayscale fast path). */
  colormap: ColormapName;
  northUp: boolean;
  overlay: boolean;
}

/** A band's grid group, defaulting to 0 (one group / single-grid dataset). */
export function gridGroupOf(band: ExplorerBand): number {
  return band.gridGroup ?? 0;
}

function find(bands: readonly ExplorerBand[], name: string): ExplorerBand | undefined {
  return bands.find((b) => b.name === name);
}

/**
 * The grid group an RGB composite is currently locked to: the group of the first
 * assigned channel (r→g→b). Null when none resolve (so nothing is greyed).
 */
export function rgbActiveGroup(
  bands: readonly ExplorerBand[],
  rgb: { r: string; g: string; b: string },
): number | null {
  for (const name of [rgb.r, rgb.g, rgb.b]) {
    const band = find(bands, name);
    if (band !== undefined) return gridGroupOf(band);
  }
  return null;
}

/**
 * Whether `band` may be assigned to an RGB channel given the current selection:
 * true when no channel is set yet, or when it shares the active group. This is the
 * greying rule — once a channel is chosen, cross-grid bands become unselectable.
 */
export function isBandSelectableForRgb(
  band: ExplorerBand,
  bands: readonly ExplorerBand[],
  rgb: { r: string; g: string; b: string },
): boolean {
  const active = rgbActiveGroup(bands, rgb);
  return active === null || gridGroupOf(band) === active;
}

/** The largest co-gridded group — the natural default for an RGB composite. */
function largestGroup(bands: readonly ExplorerBand[]): ExplorerBand[] {
  const groups = new Map<number, ExplorerBand[]>();
  for (const b of bands) {
    const g = gridGroupOf(b);
    const list = groups.get(g);
    if (list === undefined) groups.set(g, [b]);
    else list.push(b);
  }
  let best: ExplorerBand[] = [];
  for (const list of groups.values()) if (list.length > best.length) best = list;
  return best;
}

/**
 * A valid default RGB triple: the producer's `r/g/b` if all three exist, else the
 * first three bands of the largest co-gridded group (padded by repeating the last
 * so the triple is always within one grid and always renderable).
 */
function defaultTriple(
  bands: readonly ExplorerBand[],
  dv: ExplorerDefaultView | undefined,
): { r: string; g: string; b: string } {
  if (
    dv?.r !== undefined &&
    dv.g !== undefined &&
    dv.b !== undefined &&
    find(bands, dv.r) !== undefined &&
    find(bands, dv.g) !== undefined &&
    find(bands, dv.b) !== undefined
  ) {
    return { r: dv.r, g: dv.g, b: dv.b };
  }
  const group = largestGroup(bands);
  const pick = (i: number): string => (group[Math.min(i, group.length - 1)] ?? bands[0]).name;
  return { r: pick(0), g: pick(1), b: pick(2) };
}

/**
 * The initial live state from the inventory + the producer's default view. Mode
 * defaults to the producer's choice, else `single`. The RGB triple is always a
 * valid co-gridded set even when the default view names none.
 */
export function defaultExplorerState(
  bands: readonly ExplorerBand[],
  dv?: ExplorerDefaultView,
): ExplorerState {
  if (bands.length === 0) throw new Error('FitsExplorer: at least one band is required');
  const band = dv?.band !== undefined && find(bands, dv.band) !== undefined ? dv.band : bands[0].name;
  return {
    mode: dv?.mode ?? 'single',
    band,
    rgb: defaultTriple(bands, dv),
    stretch: dv?.stretch ?? 'asinh',
    trilogyParams: { ...DEFAULT_TRILOGY_PARAMS },
    colormap: dv?.colormap ?? 'gray',
    northUp: dv?.northUp ?? true,
    overlay: false,
  };
}

/** The band name backing an RGB role in the current state. */
export function bandForRole(state: ExplorerState, role: 'r' | 'g' | 'b'): string {
  return state.rgb[role];
}

/** The bands currently driving the display (1 in single mode, 3 in RGB). */
export function activeBandNames(state: ExplorerState): string[] {
  return state.mode === 'single' ? [state.band] : [state.rgb.r, state.rgb.g, state.rgb.b];
}

/**
 * Derive the controlled `ViewerConfig` for `<FitsViewer>` from the inventory +
 * live state. Stretch *ranges* are deliberately omitted — the explorer drives the
 * black/white points imperatively (high-frequency drags shouldn't churn React),
 * so the config carries only the shared transfer curve; `<FitsViewer>` then
 * auto-stretches a freshly-switched source, which the explorer reads back to seed
 * its sliders. The overlay/catalog is pushed imperatively too (a URL the host
 * fetches), so it is not a config field here.
 */
export function deriveViewerConfig(bands: readonly ExplorerBand[], state: ExplorerState): ViewerConfig {
  const view: ViewerView =
    state.mode === 'rgb'
      ? { mode: 'rgb', r: state.rgb.r, g: state.rgb.g, b: state.rgb.b }
      : state.colormap === 'gray'
        ? { mode: 'single', band: state.band }
        : { mode: 'single', band: state.band, colormap: state.colormap };
  return {
    bands: bands.map((b) => ({ name: b.name, tiles: b.tiles })),
    view,
    stretch: { mode: state.stretch },
    northUp: state.northUp,
  };
}

/** Map a `FitsglConfig`'s inventory to explorer bands (the turnkey `config` path). */
export function explorerBandsFromConfig(config: FitsglConfig): ExplorerBand[] {
  return config.dataset.bands.map((b) => {
    const band: ExplorerBand = { name: b.name, tiles: b.tiles.slice(), gridGroup: b.grid.group };
    if (b.label !== undefined) band.label = b.label;
    if (b.grid.pixelScaleArcsec !== undefined) band.pixelScaleArcsec = b.grid.pixelScaleArcsec;
    if (b.stats?.histogram !== undefined) band.histogram = b.stats.histogram;
    if (b.stats?.trilogy !== undefined) band.trilogy = b.stats.trilogy;
    return band;
  });
}

/** Map a `FitsglConfig`'s `defaultView` to the explorer's default-view shape. */
export function defaultViewFromConfig(config: FitsglConfig): ExplorerDefaultView {
  const dv = config.defaultView;
  const out: ExplorerDefaultView = { mode: dv.mode };
  if (dv.band !== undefined) out.band = dv.band;
  if (dv.r !== undefined) out.r = dv.r;
  if (dv.g !== undefined) out.g = dv.g;
  if (dv.b !== undefined) out.b = dv.b;
  if (dv.stretch?.mode !== undefined) out.stretch = dv.stretch.mode;
  if (dv.colormap !== undefined) out.colormap = dv.colormap;
  if (dv.northUp !== undefined) out.northUp = dv.northUp;
  return out;
}

/**
 * Build the explorer's inventory from a legacy `dataset.json` (`DatasetManifest`)
 * — a thin wrapper over `fitsglConfigFromDataset` (grid groups via the
 * authoritative `gridsMatch`, URLs resolved against `datasetUrl`). Lets a host (or
 * the demo) feed today's dataset manifest into `<FitsExplorer>` until a
 * `fitsgl.json` is emitted and `loadFitsglConfig` is used instead.
 */
export function explorerBandsFromDataset(
  dataset: DatasetManifest,
  datasetUrl: string,
): ExplorerBand[] {
  return explorerBandsFromConfig(fitsglConfigFromDataset(dataset, datasetUrl));
}

/** The producer's default view from a dataset manifest's `default_rgb` (if any). */
export function defaultViewFromDataset(dataset: DatasetManifest): ExplorerDefaultView {
  const rgb = dataset.default_rgb;
  if (rgb === null) return { mode: 'single' };
  return { mode: 'rgb', r: rgb.r, g: rgb.g, b: rgb.b };
}
