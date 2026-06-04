/**
 * FitsglConfig (the producer contract) — the single artifact a `fitsgl build`
 * emits (`fitsgl.json`) and every delivery tier consumes. It sits ABOVE
 * `ViewerConfig`: where `ViewerConfig` is the bare `<FitsViewer>`'s controlled
 * *view* (one specific band/RGB selection), `FitsglConfig` is the **dataset
 * inventory + an overridable default view**. The data never dictates the view —
 * RGB role assignment, stretch, and colormap are live view state; the producer
 * only sets the initial state.
 *
 * Two consumers: `<FitsExplorer config>` (the batteries-included tier) reads it
 * whole; a host wiring the bare `<FitsViewer>` maps `defaultView` → a static
 * `ViewerConfig.view`.
 *
 * URL resolution (the cross-origin fix): a `fitsgl.json` ships RELATIVE
 * `tiles`/`catalog.url` (so the directory is copy-anywhere). `loadFitsglConfig`
 * resolves them against the config's own URL, so a React/CAMPFIRE host fetching
 * the config from a CDN gets absolute URLs the viewer can fetch — not paths
 * resolved against the app origin. (Same `new URL(path, base)` rule as
 * per-level manifest filenames and dataset band paths.)
 *
 * Pure (no GL/DOM): validation + resolution unit-test under Node, mirroring the
 * dataset / catalog format validators.
 */

import { compatibleBands, resolveDatasetBandUrl, type DatasetBand, type DatasetManifest } from './dataset.js';
import { isColormapName, type ColormapName } from './renderer/colormaps.js';
import { isStretchMode, type StretchMode } from './renderer/stretch.js';

/** The FitsglConfig schema major version this client accepts. */
export const FITSGL_SCHEMA_VERSION = 1;

/** One band in the inventory: where its pyramid lives + which co-gridded group. */
export interface FitsglBand {
  /** Stable key the default view references. */
  name: string;
  /** Manifest URL(s); length 1 today (M6 = N). Relative on disk, absolute after load. */
  tiles: string[];
  /** Grid grouping: bands sharing `group` can be RGB-composited (advisory hint; the
   *  authoritative gate stays the renderer's `gridsMatch` at composite time). */
  grid: { group: number; pixelScaleArcsec?: number };
  /** Display label; defaults to `name`. */
  label?: string;
  /** Pre-computed display stats (e.g. a histogram) the stretch panel shows without
   *  a live scan; producer-emitted, a UI convenience (omitted ⇒ the viewer scans). */
  stats?: FitsglBandStats;
}

/** Pre-computed per-band display statistics for the viewer's stretch panel. */
export interface FitsglBandStats {
  /** Histogram of the band's data over a robust `[lo, hi]` domain (counts per bin). */
  histogram: { counts: number[]; lo: number; hi: number };
  /**
   * Global trilogy levels, measured on the native (z=0) data so they reflect the
   * true per-pixel noise and compact-source peaks the renderer shows at full
   * zoom. `mean`/`sigma` are the robust sky level + MAD-scaled noise; `tail`
   * carries the bright-tail percentiles (the saturation point lives beyond the
   * 99.9th the `histogram` domain is clipped to). Mirrors `TrilogyStats`; the
   * host derives `x0/x1/x2/k` from these + the user knobs with no rescan. Omitted
   * for older datasets ⇒ the viewer falls back to its live percentile stretch.
   */
  trilogy?: {
    mean: number;
    sigma: number;
    tail: { p99: number; p99_9: number; p99_99: number; p99_999: number };
  };
}

/** The dataset inventory — pure data, no view. */
export interface FitsglDataset {
  /** Machine key / URL slug. */
  name: string;
  /** Human label for the viewer chrome. */
  title?: string;
  bands: FitsglBand[];
  /** Overlay catalog: a CSV URL (relative on disk, absolute after load). */
  catalog?: { url: string };
}

/**
 * The producer's default view — the only place a default is declared, and fully
 * overridable live. `stretch.range`/`channels` are reserved for a later version
 * (the explorer auto-stretches in v1), so only the transfer `mode` is read today.
 */
export interface FitsglDefaultView {
  mode: 'single' | 'rgb';
  band?: string;
  r?: string;
  g?: string;
  b?: string;
  colormap?: ColormapName;
  stretch?: { mode?: StretchMode };
  northUp?: boolean;
}

export interface FitsglConfig {
  schemaVersion: number;
  dataset: FitsglDataset;
  defaultView: FitsglDefaultView;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function asStr(v: unknown, what: string): string {
  if (typeof v !== 'string' || v === '') throw new Error(`fitsgl-config: ${what} must be a non-empty string`);
  return v;
}
function asOptStr(v: unknown, what: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  return asStr(v, what);
}
function asFiniteNum(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`fitsgl-config: ${what} must be a finite number`);
  return v;
}
function asBandStats(v: unknown, name: string): FitsglBandStats | undefined {
  if (v === undefined || v === null) return undefined;
  if (!isObj(v)) throw new Error(`fitsgl-config: band "${name}" stats must be an object`);
  const h = v.histogram;
  if (!isObj(h)) throw new Error(`fitsgl-config: band "${name}" stats.histogram must be an object`);
  if (
    !Array.isArray(h.counts) ||
    h.counts.length === 0 ||
    !h.counts.every((c) => typeof c === 'number' && Number.isFinite(c))
  ) {
    throw new Error(`fitsgl-config: band "${name}" stats.histogram.counts must be a non-empty number array`);
  }
  const lo = asFiniteNum(h.lo, `band "${name}" stats.histogram.lo`);
  const hi = asFiniteNum(h.hi, `band "${name}" stats.histogram.hi`);
  if (!(hi > lo)) throw new Error(`fitsgl-config: band "${name}" stats.histogram requires hi > lo`);
  const out: FitsglBandStats = { histogram: { counts: (h.counts as number[]).slice(), lo, hi } };
  const tri = asTrilogyStats(v.trilogy, name);
  if (tri !== undefined) out.trilogy = tri;
  return out;
}

function asTrilogyStats(v: unknown, name: string): FitsglBandStats['trilogy'] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!isObj(v)) throw new Error(`fitsgl-config: band "${name}" stats.trilogy must be an object`);
  const t = v.tail;
  if (!isObj(t)) throw new Error(`fitsgl-config: band "${name}" stats.trilogy.tail must be an object`);
  return {
    mean: asFiniteNum(v.mean, `band "${name}" stats.trilogy.mean`),
    sigma: asFiniteNum(v.sigma, `band "${name}" stats.trilogy.sigma`),
    tail: {
      p99: asFiniteNum(t.p99, `band "${name}" stats.trilogy.tail.p99`),
      p99_9: asFiniteNum(t.p99_9, `band "${name}" stats.trilogy.tail.p99_9`),
      p99_99: asFiniteNum(t.p99_99, `band "${name}" stats.trilogy.tail.p99_99`),
      p99_999: asFiniteNum(t.p99_999, `band "${name}" stats.trilogy.tail.p99_999`),
    },
  };
}

/**
 * Structural validation of a parsed `fitsgl.json` (throws). Checks the invariants
 * the loader + viewer rely on: a known `schemaVersion`; ≥1 band with unique names,
 * non-empty length-1 `tiles` (length>1 is M6), an integer `grid.group`; a
 * `defaultView` whose band references resolve and whose colormap/stretch (when
 * present) are known. Grid *compatibility* of an RGB default is not checked here —
 * that is the renderer's `gridsMatch` at composite time (the build warns).
 */
export function validateFitsglConfig(raw: unknown): FitsglConfig {
  if (!isObj(raw)) throw new Error('fitsgl-config: top-level value is not an object');

  if (raw.schemaVersion === undefined) {
    throw new Error(`fitsgl-config: missing "schemaVersion" (expected ${FITSGL_SCHEMA_VERSION}).`);
  }
  if (typeof raw.schemaVersion !== 'number' || !Number.isInteger(raw.schemaVersion)) {
    throw new Error(`fitsgl-config: "schemaVersion" must be an integer (got ${JSON.stringify(raw.schemaVersion)}).`);
  }
  if (raw.schemaVersion !== FITSGL_SCHEMA_VERSION) {
    throw new Error(
      `fitsgl-config: unsupported schemaVersion ${raw.schemaVersion} (this client supports ${FITSGL_SCHEMA_VERSION}).`,
    );
  }

  const ds = raw.dataset;
  if (!isObj(ds)) throw new Error('fitsgl-config: "dataset" must be an object');
  if (!Array.isArray(ds.bands) || ds.bands.length === 0) {
    throw new Error('fitsgl-config: "dataset.bands" must be a non-empty array');
  }

  const names = new Set<string>();
  const bands: FitsglBand[] = ds.bands.map((rawBand, i): FitsglBand => {
    if (!isObj(rawBand)) throw new Error(`fitsgl-config: band ${i} is not an object`);
    const name = asStr(rawBand.name, `band ${i} name`);
    if (names.has(name)) throw new Error(`fitsgl-config: duplicate band name "${name}"`);
    names.add(name);

    const tilesRaw = rawBand.tiles;
    if (!Array.isArray(tilesRaw) || tilesRaw.length === 0) {
      throw new Error(`fitsgl-config: band "${name}" needs a non-empty "tiles" list`);
    }
    const tiles = tilesRaw.map((t, j) => asStr(t, `band "${name}" tile ${j}`));
    if (tiles.length > 1) {
      throw new Error(
        `fitsgl-config: band "${name}" has ${tiles.length} tiles — multi-tile mosaics are an M6 feature (D14).`,
      );
    }

    const gridRaw = rawBand.grid;
    if (!isObj(gridRaw)) throw new Error(`fitsgl-config: band "${name}" needs a "grid" object`);
    if (typeof gridRaw.group !== 'number' || !Number.isInteger(gridRaw.group)) {
      throw new Error(`fitsgl-config: band "${name}" grid.group must be an integer`);
    }
    const grid: FitsglBand['grid'] = { group: gridRaw.group };
    if (gridRaw.pixelScaleArcsec !== undefined) {
      grid.pixelScaleArcsec = asFiniteNum(gridRaw.pixelScaleArcsec, `band "${name}" grid.pixelScaleArcsec`);
    }

    const band: FitsglBand = { name, tiles, grid };
    const label = asOptStr(rawBand.label, `band "${name}" label`);
    if (label !== undefined) band.label = label;
    const stats = asBandStats(rawBand.stats, name);
    if (stats !== undefined) band.stats = stats;
    return band;
  });

  const dataset: FitsglDataset = { name: asStr(ds.name, 'dataset.name'), bands };
  const title = asOptStr(ds.title, 'dataset.title');
  if (title !== undefined) dataset.title = title;
  if (ds.catalog !== undefined && ds.catalog !== null) {
    if (!isObj(ds.catalog)) throw new Error('fitsgl-config: "dataset.catalog" must be an object');
    dataset.catalog = { url: asStr(ds.catalog.url, 'dataset.catalog.url') };
  }

  const dvRaw = raw.defaultView;
  if (!isObj(dvRaw)) throw new Error('fitsgl-config: "defaultView" must be an object');
  if (dvRaw.mode !== 'single' && dvRaw.mode !== 'rgb') {
    throw new Error('fitsgl-config: defaultView.mode must be "single" or "rgb"');
  }
  const requireBand = (n: string, where: string): void => {
    if (!names.has(n)) throw new Error(`fitsgl-config: defaultView.${where} references unknown band "${n}"`);
  };
  const defaultView: FitsglDefaultView = { mode: dvRaw.mode };
  if (dvRaw.mode === 'single') {
    if (dvRaw.band !== undefined) {
      const band = asStr(dvRaw.band, 'defaultView.band');
      requireBand(band, 'band');
      defaultView.band = band;
    }
    if (dvRaw.colormap !== undefined) {
      const cm = asStr(dvRaw.colormap, 'defaultView.colormap');
      if (!isColormapName(cm)) throw new Error(`fitsgl-config: defaultView.colormap "${cm}" is not a known colormap`);
      defaultView.colormap = cm;
    }
  } else {
    const r = asStr(dvRaw.r, 'defaultView.r');
    const g = asStr(dvRaw.g, 'defaultView.g');
    const b = asStr(dvRaw.b, 'defaultView.b');
    requireBand(r, 'r');
    requireBand(g, 'g');
    requireBand(b, 'b');
    defaultView.r = r;
    defaultView.g = g;
    defaultView.b = b;
  }
  if (dvRaw.stretch !== undefined && dvRaw.stretch !== null) {
    if (!isObj(dvRaw.stretch)) throw new Error('fitsgl-config: "defaultView.stretch" must be an object');
    if (dvRaw.stretch.mode !== undefined) {
      const mode = asStr(dvRaw.stretch.mode, 'defaultView.stretch.mode');
      if (!isStretchMode(mode)) throw new Error(`fitsgl-config: defaultView.stretch.mode "${mode}" is not a known stretch mode`);
      defaultView.stretch = { mode };
    } else {
      defaultView.stretch = {};
    }
  }
  if (dvRaw.northUp !== undefined) {
    if (typeof dvRaw.northUp !== 'boolean') throw new Error('fitsgl-config: defaultView.northUp must be a boolean');
    defaultView.northUp = dvRaw.northUp;
  }

  return { schemaVersion: FITSGL_SCHEMA_VERSION, dataset, defaultView };
}

/**
 * Resolve every `tiles[]` and `catalog.url` against `baseUrl` (the config's own
 * URL), returning a config whose URLs are absolute and cross-origin-safe. Pure.
 */
export function resolveFitsglConfig(config: FitsglConfig, baseUrl: string): FitsglConfig {
  const bands = config.dataset.bands.map((b): FitsglBand => ({
    ...b,
    tiles: b.tiles.map((t) => new URL(t, baseUrl).toString()),
  }));
  const dataset: FitsglDataset = { ...config.dataset, bands };
  if (config.dataset.catalog !== undefined) {
    dataset.catalog = { url: new URL(config.dataset.catalog.url, baseUrl).toString() };
  }
  return { ...config, dataset };
}

/**
 * Fetch, validate, and URL-resolve a `fitsgl.json`. The returned config's tile +
 * catalog URLs are absolute (resolved against `url`), so it can be handed straight
 * to `<FitsExplorer config>` or mapped to a `<FitsViewer>` `ViewerConfig`.
 */
export async function loadFitsglConfig(url: string, fetchImpl: typeof fetch = fetch): Promise<FitsglConfig> {
  const resp = await fetchImpl(url);
  if (!resp.ok) {
    throw new Error(`fitsgl-config fetch failed: ${resp.status} ${resp.statusText} for ${url}`);
  }
  const json: unknown = await resp.json();
  return resolveFitsglConfig(validateFitsglConfig(json), url);
}

/**
 * Build a `FitsglConfig` from a legacy `dataset.json` (`DatasetManifest`) — the
 * transition bridge until `fitsgl build` emits `fitsgl.json` directly. Band
 * manifest paths are resolved to absolute against `datasetUrl`; grid groups are
 * assigned via the authoritative `gridsMatch` (bucketed by the first earlier band
 * each is grid-compatible with); `default_rgb` becomes the default view.
 */
export function fitsglConfigFromDataset(dataset: DatasetManifest, datasetUrl: string): FitsglConfig {
  const reps: DatasetBand[] = [];
  const groupOf = (band: DatasetBand): number => {
    const existing = reps.findIndex((rep) => compatibleBands(rep, [band]).length > 0);
    if (existing !== -1) return existing;
    reps.push(band);
    return reps.length - 1;
  };
  const bands: FitsglBand[] = dataset.bands.map((b) => ({
    name: b.name,
    label: b.name,
    tiles: [resolveDatasetBandUrl(datasetUrl, b.path)],
    grid: { group: groupOf(b), pixelScaleArcsec: b.pixel_scale_arcsec },
  }));
  const rgb = dataset.default_rgb;
  const defaultView: FitsglDefaultView =
    rgb === null
      ? { mode: 'single', band: dataset.bands[0].name }
      : { mode: 'rgb', r: rgb.r, g: rgb.g, b: rgb.b };
  return { schemaVersion: FITSGL_SCHEMA_VERSION, dataset: { name: 'dataset', bands }, defaultView };
}
