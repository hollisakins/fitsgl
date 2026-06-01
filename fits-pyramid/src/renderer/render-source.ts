/**
 * Render-source model + the pure grid-compatibility guard (M4, decisions D7/D8).
 *
 * Split out of the GL-bound `FitsViewer` so the grid math unit-tests under Node
 * with no WebGL2 context (the project's split-pure-logic-from-GL rule): what a
 * viewer draws (one band, or three same-grid bands), how a source normalizes to
 * an ordered manager list, and whether a candidate band shares the viewer's
 * construction grid. The last check is `gridsMatch` (identical native shape +
 * WCS) AND `geomsEqual` (identical per-level tiling) — the latter catches a
 * same-shape pyramid built with a different fpack tile size, which `gridsMatch`
 * alone would accept and which would mis-tile the composite.
 *
 * Pure: no GL, no DOM. (`TilePyramid` here is a data handle — `getManifest()` —
 * not a GL object.)
 */

import type { TilePyramid } from '../fpack/tile-source.js';
import type { Manifest } from '../manifest.js';
import { gridsMatch, type GridSpec } from '../wcs/grid-match.js';
import { buildLevelGeoms, type LevelGeom } from './tile-manager.js';

/** Single-band render source: one pyramid, drawn grayscale or via a colormap. */
export interface SingleBandSource {
  kind: 'single';
  pyramid: TilePyramid;
}

/**
 * RGB composite render source: three single-band pyramids sharing an identical
 * pixel grid + WCS, drawn as one color image (R/G/B). The grids must match
 * (`gridsMatch`/`isCompatibleGrid`) because compositing samples all three at one
 * shared texcoord with no in-browser resampling (D7).
 */
export interface RgbSource {
  kind: 'rgb';
  r: TilePyramid;
  g: TilePyramid;
  b: TilePyramid;
}

/**
 * What a viewer draws: a single band, or an RGB composite. A bare `TilePyramid`
 * is shorthand for `{ kind: 'single', pyramid }` (the pre-M4 constructor signature
 * stays valid).
 */
export type RenderSource = SingleBandSource | RgbSource;

export interface NormalizedSource {
  mode: 'single' | 'rgb';
  /** length 1 for single-band; length 3 (R, G, B in order) for RGB. */
  pyramids: TilePyramid[];
}

export function isRenderSource(s: TilePyramid | RenderSource): s is RenderSource {
  const kind = (s as { kind?: unknown }).kind;
  return kind === 'single' || kind === 'rgb';
}

/** Normalize the constructor/`setSource` argument to a mode + ordered pyramids. */
export function normalizeSource(source: TilePyramid | RenderSource): NormalizedSource {
  if (isRenderSource(source)) {
    if (source.kind === 'rgb') return { mode: 'rgb', pyramids: [source.r, source.g, source.b] };
    return { mode: 'single', pyramids: [source.pyramid] };
  }
  return { mode: 'single', pyramids: [source] };
}

/** A manifest's grid identity (z=0 WCS + native shape) for `gridsMatch`. */
export function manifestGridSpec(manifest: Manifest): GridSpec {
  const z0 = manifest.levels.find((l) => l.z === 0);
  return { wcs: z0 !== undefined ? z0.wcs : {}, shape: manifest.native_shape };
}

/** Deep-equal of two level-geometry maps (per-z shape + tile counts). */
export function geomsEqual(a: Map<number, LevelGeom>, b: Map<number, LevelGeom>): boolean {
  if (a.size !== b.size) return false;
  for (const [z, ga] of a) {
    const gb = b.get(z);
    if (gb === undefined) return false;
    if (ga.levelW !== gb.levelW || ga.levelH !== gb.levelH) return false;
    if (ga.nTilesX !== gb.nTilesX || ga.nTilesY !== gb.nTilesY) return false;
  }
  return true;
}

/**
 * Whether `manifest` shares the construction grid (`gridSpec` + `geoms`):
 * identical native shape + WCS (`gridsMatch`) AND identical per-level tiling
 * (`geomsEqual` — catches a same-shape pyramid built with a different fpack tile
 * size, which `gridsMatch` alone would accept). This is what lets every band
 * reuse the one set of grid-derived viewer state and one shared UV per tile.
 */
export function isCompatibleGrid(
  gridSpec: GridSpec,
  geoms: Map<number, LevelGeom>,
  manifest: Manifest,
): boolean {
  return (
    gridsMatch(gridSpec, manifestGridSpec(manifest)) && geomsEqual(geoms, buildLevelGeoms(manifest))
  );
}
