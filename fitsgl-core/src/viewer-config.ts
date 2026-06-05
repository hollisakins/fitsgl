/**
 * ViewerConfig (M5) — the single high-level description every delivery tier
 * (React, vanilla embed, SSG) consumes, so a feature is declared in exactly one
 * type and stays reachable from each tier (roadmap §3.1/§3.5). A host hands the
 * viewer a *list of bands* (each a name + manifest URL(s)) plus the initial view
 * state; the library — not the host — fetches the manifests and builds the
 * `RenderSource`, so `setSource`/`TilePyramid` wiring lives in one place.
 *
 * A band carries a `tiles` list, length 1 for an ordinary image. Length > 1 (a
 * field too large to drizzle whole, composited from co-gridded offset tiles) is
 * the M6 tiled-mosaic case (decision D14); this M5 loader requires length 1 and
 * rejects the rest with a clear "M6" error, so the contract is frozen now and an
 * M6 mosaic will need no config change.
 */

import { TilePyramid, type TilePyramidOptions } from './fpack/tile-source.js';
import { isColormapName, isStretchMode, MAX_BANDS } from './renderer/index.js';
import type {
  ColormapLUT,
  ColormapName,
  RenderSource,
  StretchMode,
} from './renderer/index.js';
import type { MarkerInput } from './overlay/index.js';

/**
 * A band: one or more co-gridded tile-pyramids. length 1 today; N is an M6 mosaic
 * (D14). Which band(s) are shown — and any RGB role assignment — is the `view`'s
 * job, so a band carries no role here (the producer's `default_rgb` lives in the
 * dataset manifest and is read when a host builds the `view`).
 */
export interface BandConfig {
  /** Stable key the view references. Must be unique within `bands`. */
  name: string;
  /** Manifest URL(s) for the band's tile-pyramid(s). length 1 = ordinary image. */
  tiles: string[];
}

/** A display interval (min/max in raw data units). */
export interface StretchRange {
  min: number;
  max: number;
}

/**
 * Initial stretch. The transfer curve (`mode`) is shared across RGB channels
 * (decision D5). Omit `range`/`channels` (or a single channel) to auto-stretch
 * that band to the data in view on the first frame.
 */
export interface ViewerStretchConfig {
  mode?: StretchMode;
  /** Single-band interval; omit to auto-stretch. */
  range?: StretchRange;
  /** Per-channel intervals for RGB; omit a channel to auto-stretch it. */
  channels?: { r?: StretchRange; g?: StretchRange; b?: StretchRange };
}

/** One band in a weighted multi-band composite: a band name + its (R,G,B) weight. */
export interface WeightedBandView {
  band: string;
  weight: readonly [number, number, number];
}

/**
 * The initial view: one band (optionally colormapped), three bands as R/G/B, or
 * a weighted multi-band composite (N bands, each with an (R,G,B) contribution —
 * the faithful-trilogy path). `rgb` is the special case of `multiband` with 3
 * bands on unit per-channel weights, kept distinct so the strict-3 path is
 * untouched.
 */
export type ViewerView =
  | { mode: 'single'; band: string; colormap?: ColormapName | ColormapLUT }
  | { mode: 'rgb'; r: string; g: string; b: string }
  | { mode: 'multiband'; bands: WeightedBandView[] };

/** Overlay markers: a CSV/JSON catalog URL, or an inline (host-pushed) set. */
export type OverlaySource = { url: string } | { markers: MarkerInput[] };

export interface ViewerConfig {
  /** Available bands. The view selects which one(s) are shown. */
  bands: BandConfig[];
  view: ViewerView;
  stretch?: ViewerStretchConfig;
  /** North-up rendering; omit to use the viewer default (on when a WCS is present). */
  northUp?: boolean;
  overlay?: OverlaySource;
}

/**
 * Structural validation of a config (throws). Checks the invariants the loader
 * relies on: at least one band, unique band names, non-empty string tile URLs,
 * every view reference resolves to a band, the stretch matches the view mode with
 * finite ranges, and — until M6 — exactly one tile per band. Grid compatibility of
 * an RGB triple is the viewer's job at construction, not checked here.
 */
export function validateViewerConfig(config: ViewerConfig): void {
  if (!Array.isArray(config.bands) || config.bands.length === 0) {
    throw new Error('ViewerConfig: "bands" must be a non-empty array');
  }
  const names = new Set<string>();
  for (const band of config.bands) {
    if (typeof band.name !== 'string' || band.name === '') {
      throw new Error('ViewerConfig: every band needs a non-empty "name"');
    }
    if (names.has(band.name)) {
      throw new Error(`ViewerConfig: duplicate band name "${band.name}"`);
    }
    names.add(band.name);
    if (!Array.isArray(band.tiles) || band.tiles.length === 0) {
      throw new Error(`ViewerConfig: band "${band.name}" needs a non-empty "tiles" list`);
    }
    for (const tile of band.tiles) {
      if (typeof tile !== 'string' || tile === '') {
        throw new Error(`ViewerConfig: band "${band.name}" has a non-string/empty tile URL`);
      }
    }
    if (band.tiles.length > 1) {
      throw new Error(
        `ViewerConfig: band "${band.name}" has ${band.tiles.length} tiles — multi-tile ` +
          'mosaics are an M6 feature; this version renders one tile per band (D14).',
      );
    }
  }

  const requireBand = (name: string, where: string): void => {
    if (!names.has(name)) {
      throw new Error(`ViewerConfig: ${where} references unknown band "${name}"`);
    }
  };
  if (config.view.mode === 'single') {
    requireBand(config.view.band, 'view.band');
    const cm = config.view.colormap;
    if (typeof cm === 'string' && !isColormapName(cm)) {
      throw new Error(`ViewerConfig: view.colormap "${cm}" is not a known colormap`);
    }
  } else if (config.view.mode === 'rgb') {
    requireBand(config.view.r, 'view.r');
    requireBand(config.view.g, 'view.g');
    requireBand(config.view.b, 'view.b');
  } else {
    const mb = config.view.bands;
    if (!Array.isArray(mb) || mb.length === 0) {
      throw new Error('ViewerConfig: a multiband view needs a non-empty "bands" list');
    }
    if (mb.length > MAX_BANDS) {
      throw new Error(
        `ViewerConfig: a multiband view mixes at most ${MAX_BANDS} bands (got ${mb.length})`,
      );
    }
    for (const wb of mb) {
      requireBand(wb.band, 'view.bands[].band');
      if (
        !Array.isArray(wb.weight) ||
        wb.weight.length !== 3 ||
        !wb.weight.every((c) => Number.isFinite(c))
      ) {
        throw new Error(
          `ViewerConfig: band "${wb.band}" weight must be 3 finite numbers [r, g, b]`,
        );
      }
    }
  }

  validateStretchConfig(config.stretch, config.view.mode);
}

/** Validate `stretch` against the view mode: matching shape + finite, ordered ranges. */
function validateStretchConfig(
  stretch: ViewerStretchConfig | undefined,
  mode: 'single' | 'rgb' | 'multiband',
): void {
  if (stretch === undefined) return;
  if (stretch.mode !== undefined && !isStretchMode(stretch.mode)) {
    throw new Error(`ViewerConfig: stretch.mode "${stretch.mode}" is not a known stretch mode`);
  }
  const checkRange = (r: StretchRange, where: string): void => {
    if (!Number.isFinite(r.min) || !Number.isFinite(r.max)) {
      throw new Error(`ViewerConfig: ${where} min/max must be finite numbers`);
    }
    if (!(r.max > r.min)) {
      throw new Error(`ViewerConfig: ${where} requires max > min`);
    }
  };
  if (mode === 'single') {
    if (stretch.channels !== undefined) {
      throw new Error('ViewerConfig: a single-band view cannot use stretch.channels (use stretch.range)');
    }
    if (stretch.range !== undefined) checkRange(stretch.range, 'stretch.range');
  } else if (mode === 'rgb') {
    if (stretch.range !== undefined) {
      throw new Error('ViewerConfig: an rgb view cannot use stretch.range (use stretch.channels)');
    }
    if (stretch.channels !== undefined) {
      for (const ch of ['r', 'g', 'b'] as const) {
        const r = stretch.channels[ch];
        if (r !== undefined) checkRange(r, `stretch.channels.${ch}`);
      }
    }
  } else {
    // Multiband is the trilogy path: levels come from precomputed per-band stats,
    // not a manual interval — so neither range nor channels applies here.
    if (stretch.range !== undefined || stretch.channels !== undefined) {
      throw new Error(
        'ViewerConfig: a multiband view derives trilogy levels from stats (no range/channels)',
      );
    }
  }
}

/** Build the initial `RenderSource` from `view`, given the loaded band pyramids. */
export function renderSourceForView(
  view: ViewerView,
  pyramids: ReadonlyMap<string, TilePyramid>,
): RenderSource {
  const need = (name: string): TilePyramid => {
    const p = pyramids.get(name);
    if (p === undefined) throw new Error(`ViewerConfig: no loaded pyramid for band "${name}"`);
    return p;
  };
  if (view.mode === 'single') return { kind: 'single', pyramid: need(view.band) };
  if (view.mode === 'rgb') return { kind: 'rgb', r: need(view.r), g: need(view.g), b: need(view.b) };
  return {
    kind: 'multiband',
    bands: view.bands.map((wb) => ({ pyramid: need(wb.band), weight: wb.weight })),
  };
}

export interface LoadedViewerSource {
  /** Every band's pyramid, keyed by name — so a host can switch bands cheaply. */
  pyramids: Map<string, TilePyramid>;
  /** The initial render source built from `config.view`. */
  source: RenderSource;
}

/**
 * Fetch the manifests for every band in `config` and build the initial render
 * source from `config.view`. All bands are loaded (not just the view's) so a host
 * can switch bands without a round-trip. Validates first (throws on a bad config,
 * including an M6 multi-tile band). The caller owns the returned pyramids and must
 * `destroy()` them on teardown.
 */
export async function loadViewerSource(
  config: ViewerConfig,
  opts: TilePyramidOptions = {},
): Promise<LoadedViewerSource> {
  validateViewerConfig(config);
  // Load all bands concurrently; if any fails, destroy the ones that succeeded so
  // a partial load never leaks GPU/heap resources before rethrowing.
  const settled = await Promise.allSettled(
    config.bands.map((band) => TilePyramid.load(band.tiles[0], opts)),
  );
  const failure = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
  if (failure !== undefined) {
    for (const s of settled) {
      if (s.status === 'fulfilled') s.value.destroy();
    }
    throw failure.reason instanceof Error ? failure.reason : new Error(String(failure.reason));
  }
  const pyramids = new Map<string, TilePyramid>(
    config.bands.map((band, i) => [
      band.name,
      (settled[i] as PromiseFulfilledResult<TilePyramid>).value,
    ]),
  );
  return { pyramids, source: renderSourceForView(config.view, pyramids) };
}
