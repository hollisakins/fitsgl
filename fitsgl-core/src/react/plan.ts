/**
 * Pure config-diff planner for the React tier (decision D12) — no React, no GL,
 * fully unit-testable under Node.
 *
 * The `<FitsViewer>` component is *controlled* by a single `ViewerConfig` prop.
 * On each change it must route the difference to the cheapest viewer call rather
 * than rebuild: a band-URL change needs a full reload, but a colormap or stretch
 * change is a one-line setter on the live viewer. This module is the decision
 * layer — `planConfigUpdate(prev, next)` returns which actions the component must
 * run — split out from the GL/DOM side effects so the routing logic tests without
 * a browser (matching the repo's pure-logic/side-effect split).
 *
 * The signature helpers double as stable React effect dependencies: a host that
 * passes a fresh `config` object every render still gets a stable string per
 * sub-config, so the apply effect fires only on a real change.
 */

import type { ViewerConfig, ViewerView, ViewerStretchConfig, StretchMode } from '../index.js';

/**
 * What changed between two configs, in terms of the viewer calls the component
 * must make. `reloadBands` is exclusive: when true the bands (and therefore the
 * pyramids) changed, so the component reloads and reconstructs the viewer, which
 * re-applies every display field from scratch — the other flags are then `false`.
 */
export interface ConfigUpdatePlan {
  /** Band names/URLs changed (or first apply): reload pyramids + rebuild viewer. */
  reloadBands: boolean;
  /** View mode or band selection changed: `setSource(renderSourceForView(...))`. */
  setSource: boolean;
  /** Single-band colormap changed (incl. cleared when switching to RGB): `setColormap`. */
  colormap: boolean;
  /** Transfer curve changed: `setStretchMode`. */
  stretchMode: boolean;
  /** Display interval(s) changed: `setStretch`/`setChannelStretch`, or auto-stretch. */
  stretch: boolean;
  /** North-up toggled (only when explicitly controlled): `setNorthUp`. */
  northUp: boolean;
}

/** The viewer's default transfer curve when a config omits `stretch.mode`. */
export const DEFAULT_STRETCH_MODE: StretchMode = 'linear';

/** Stable key for the band set (names + tile URLs) — drives the reload effect. */
export function bandsSignature(config: ViewerConfig): string {
  return JSON.stringify(config.bands.map((b) => [b.name, b.tiles]));
}

/**
 * Stable key for the *render source* selection — mode + which band(s) fill it,
 * deliberately excluding the colormap (a separate `setColormap`, not `setSource`)
 * AND the multiband per-band weights (a separate imperative `setBandWeights`, so a
 * weight tweak repaints without rebuilding the source — only a change to the *set*
 * of bands forces a `setSource`).
 */
export function viewSignature(view: ViewerView): string {
  switch (view.mode) {
    case 'single':
      return `single:${view.band}`;
    case 'rgb':
      return `rgb:${view.r}|${view.g}|${view.b}`;
    case 'multiband':
      return `mb:${view.bands.map((b) => b.band).join('|')}`;
  }
}

/**
 * Stable key for the single-band colormap. RGB has none ('none'); a missing
 * colormap is the grayscale path ('gray'); a raw LUT is keyed by reference length
 * (a host swapping LUT *contents* at equal length should pass a new name or remount).
 */
export function colormapSignature(view: ViewerView): string {
  if (view.mode !== 'single') return 'none';
  const cm = view.colormap;
  if (cm === undefined || cm === null) return 'gray';
  return typeof cm === 'string' ? `name:${cm}` : `lut:${cm.length}`;
}

function stretchModeOf(config: ViewerConfig): StretchMode {
  return config.stretch?.mode ?? DEFAULT_STRETCH_MODE;
}

/** Key for the display interval(s) only (range/channels) — excludes the mode. */
export function stretchRangeSignature(stretch: ViewerStretchConfig | undefined): string {
  return JSON.stringify({ range: stretch?.range ?? null, channels: stretch?.channels ?? null });
}

/** Combined stretch key (mode + interval) — one stable React effect dependency. */
export function stretchSignature(stretch: ViewerStretchConfig | undefined): string {
  return JSON.stringify({
    mode: stretch?.mode ?? null,
    range: stretch?.range ?? null,
    channels: stretch?.channels ?? null,
  });
}

/** North-up effect dependency: the controlled boolean, or `null` when uncontrolled. */
export function northUpDependency(config: ViewerConfig): boolean | null {
  return config.northUp ?? null;
}

const NO_CHANGE: ConfigUpdatePlan = {
  reloadBands: false,
  setSource: false,
  colormap: false,
  stretchMode: false,
  stretch: false,
  northUp: false,
};

/**
 * Decide which viewer calls take `prev` to `next`. `prev === null` is the first
 * apply (mount) — a reload. A change to the band set is also a reload, and being
 * exclusive it short-circuits the per-field diffs (the rebuilt viewer re-applies
 * them). Otherwise each display field is compared independently.
 *
 * North-up is only flagged when `next.northUp` is explicitly set *and* differs:
 * omitting it leaves the field uncontrolled (the viewer keeps its current state),
 * so a host that never sets `northUp` never fights the viewer's WCS-derived default.
 */
export function planConfigUpdate(prev: ViewerConfig | null, next: ViewerConfig): ConfigUpdatePlan {
  if (prev === null) return { ...NO_CHANGE, reloadBands: true };
  if (bandsSignature(prev) !== bandsSignature(next)) return { ...NO_CHANGE, reloadBands: true };
  return {
    reloadBands: false,
    setSource: viewSignature(prev.view) !== viewSignature(next.view),
    colormap: colormapSignature(prev.view) !== colormapSignature(next.view),
    stretchMode: stretchModeOf(prev) !== stretchModeOf(next),
    stretch: stretchRangeSignature(prev.stretch) !== stretchRangeSignature(next.stretch),
    northUp: next.northUp !== undefined && next.northUp !== prev.northUp,
  };
}
