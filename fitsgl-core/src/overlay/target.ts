/**
 * The go-to TARGET: a single sky-locked crosshair the viewer pins at a coordinate
 * ("jump to RA/Dec"). Pure — no GL, no DOM — so it unit-tests under Node.
 *
 * Why it is not a marker: the target is chrome, not catalog data. The marker store
 * feeds hover/click/tooltip and the hit-test broad phase, and hosts replace it
 * wholesale (`setMarkers` is replace-all, e.g. when a catalog overlay toggles), so
 * a target living there would be clickable, would widen the broad-phase radius,
 * and would vanish on the next catalog push. Instead the viewer keeps ONE resolved
 * target and draws it through a dedicated single-instance overlay pass, on top of
 * markers and regions.
 *
 * It reuses the marker vocabulary where that is genuinely the same thing: the
 * coordinate convention (`ra`/`dec` in ICRS degrees via `skyToPix`, else 0-based
 * ARRAY pixels `x`/`y` so world = x + 0.5), colour parsing, and the packed
 * instance layout — `targetMarker` adapts a `ResolvedTarget` to the `ResolvedMarker`
 * shape `packOne` consumes, with the `cross` glyph.
 */

import type { TanWcs } from '../wcs/tan.js';
import {
  parseColor,
  resolveMarkerWorld,
  type ColorInput,
  type ColorTuple,
  type ResolvedMarker,
} from './markers.js';

/** The target as supplied by a host: a sky position (primary) or a pixel one. */
export interface TargetInput {
  /** ICRS sky position (deg). The primary path; requires a usable WCS. */
  ra?: number;
  dec?: number;
  /** 0-based array pixel position (world = x + 0.5). Used when `ra`/`dec` absent. */
  x?: number;
  y?: number;
  /** Reticle arm-to-arm span in CSS px (screen-constant across zoom). */
  size?: number;
  color?: ColorInput;
  /** Stroke width in CSS px. */
  edgeWidth?: number;
}

/** A placed target: a fixed world position + a concrete style. */
export interface ResolvedTarget {
  /** Resolved world (native-pixel) position. */
  readonly x: number;
  readonly y: number;
  /** ICRS sky position (deg) if known (sky input, or pixel input with a WCS). */
  readonly ra: number | null;
  readonly dec: number | null;
  readonly size: number;
  readonly color: ColorTuple;
  readonly edgeWidth: number;
  /**
   * Whether the target lands within the mosaic's native bounds. A coordinate off
   * the image is still a valid target (the reticle marks where it is on the sky, so
   * a host can say "outside image" and offer fit-to-view) — false, never a drop.
   */
  readonly insideImage: boolean;
}

/** The reticle id in the instance stream; never collides with a marker id. */
export const TARGET_ID = '__fitsgl_target';
/** Default reticle span (CSS px) — bigger than a catalog glyph, it marks a place. */
export const DEFAULT_TARGET_SIZE = 28;
/** Default reticle stroke (CSS px). */
export const DEFAULT_TARGET_EDGE = 1.5;
/** Default reticle colour (cyan) — deliberately not the amber of catalog markers. */
export const DEFAULT_TARGET_COLOR: ColorTuple = [0.35, 0.9, 1, 1];

function positive(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/**
 * Resolve a target to a world position + style, or null when it cannot be placed
 * (sky input with no WCS, no usable coordinate at all, or a non-finite projection
 * such as the antipode) — the same precedence as `resolveMarkerWorld`.
 *
 * `image` is the mosaic's native size, used only to compute `insideImage`; pass
 * null when it is unknown (`insideImage` is then false).
 */
export function resolveTarget(
  input: TargetInput,
  wcs: TanWcs | null,
  image: { width: number; height: number } | null,
): ResolvedTarget | null {
  const world = resolveMarkerWorld(input, wcs);
  if (world === null) return null;
  const parsed = input.color === undefined ? null : parseColor(input.color);
  return {
    x: world.x,
    y: world.y,
    ra: world.ra,
    dec: world.dec,
    size: positive(input.size) ? input.size : DEFAULT_TARGET_SIZE,
    color: parsed ?? DEFAULT_TARGET_COLOR,
    edgeWidth:
      typeof input.edgeWidth === 'number' && Number.isFinite(input.edgeWidth) && input.edgeWidth >= 0
        ? input.edgeWidth
        : DEFAULT_TARGET_EDGE,
    insideImage:
      image !== null && world.x >= 0 && world.x <= image.width && world.y >= 0 && world.y <= image.height,
  };
}

/**
 * Adapt a resolved target to the `ResolvedMarker` shape the instance packer
 * consumes, as a `cross` glyph. It never enters the marker store — this is only
 * the packing adapter for the target's own single-instance draw.
 */
export function targetMarker(target: ResolvedTarget): ResolvedMarker {
  return {
    id: TARGET_ID,
    x: target.x,
    y: target.y,
    ra: target.ra,
    dec: target.dec,
    shape: 'cross',
    size: target.size,
    color: target.color,
    edgeWidth: target.edgeWidth,
    data: {},
  };
}
