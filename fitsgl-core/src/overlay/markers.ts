/**
 * Marker model + store (M3 overlays, decision D10) — pure, no GL, no DOM.
 *
 * A marker is a point/circle/box glyph positioned in SKY (RA/Dec, ICRS — the
 * primary path) or in image PIXELS (a documented subset). The store resolves
 * every marker to a fixed *world* (native-pixel) position once, so rendering and
 * hit-testing are view-independent: pan/zoom/North-up only change uniforms, never
 * the marker data (the D10 large-catalog goal). This module owns the marker
 * types, the store (add/update/remove with the O(1) restyle path the renderer
 * needs), and the pure colour/shape parsing the CSV catalog path reuses.
 *
 * Coordinate convention (deliberate, tested in markers.test.ts):
 *   - `ra`/`dec` are ICRS degrees and go through `skyToPix` (astropy-gated).
 *   - `x`/`y` are 0-based ARRAY pixels (astropy `origin=0`, the convention the
 *     fitsgl catalog writes), so the centre of array pixel k maps to the
 *     renderer's world `k + 0.5`. This intentionally differs from
 *     `CursorInfo.worldX`, which is already a world coordinate — markers take the
 *     catalog convention because a catalog is the realistic pixel source.
 *   - A marker built from `{x, y}` lands at the same world point as one built
 *     from the `{ra, dec}` of the same source (verified to ~1e-9 px).
 */

import { pixToSky, skyToPix, type TanWcs } from '../wcs/tan.js';

/** The three v1.0 marker glyphs (roadmap: simple shapes only). */
export const MARKER_SHAPES = ['point', 'circle', 'box'] as const;
export type MarkerShape = (typeof MARKER_SHAPES)[number];

/** Shape ids: the integer the instance buffer carries and the frag shader branches on. */
export const SHAPE_IDS: Record<MarkerShape, number> = { point: 0, circle: 1, box: 2 };

/** RGBA in [0, 1]. The resolved form every marker carries. */
export type ColorTuple = readonly [number, number, number, number];
/** Colour input: a CSS-ish `#hex`/named string, or an `[r,g,b(,a)]` tuple in [0,1]. */
export type ColorInput = string | readonly [number, number, number] | readonly [number, number, number, number];

/** Default glyph style (amber `#ffcc00`, readable on a grayscale field). */
export const DEFAULT_MARKER_SHAPE: MarkerShape = 'circle';
export const DEFAULT_MARKER_SIZE = 12; // CSS px (diameter / box side)
export const DEFAULT_MARKER_EDGE = 1.5; // CSS px stroke for circle/box
export const DEFAULT_MARKER_COLOR: ColorTuple = [1, 0.8, 0, 1];

/** A marker as supplied by a caller (React) or the CSV parser (SSG). */
export interface MarkerInput {
  /** Caller id; auto-assigned if omitted. Must be unique within the store. */
  id?: string;
  /** ICRS sky position (deg). The primary path; requires a usable WCS. */
  ra?: number;
  dec?: number;
  /** 0-based array pixel position (world = x + 0.5). Used when `ra`/`dec` absent. */
  x?: number;
  y?: number;
  shape?: MarkerShape;
  /** Glyph diameter / box side in CSS px. */
  size?: number;
  color?: ColorInput;
  /** Stroke width (CSS px) for `circle`/`box`; ignored for filled `point`. */
  edgeWidth?: number;
  /** Arbitrary per-marker payload, surfaced on hover/click and in the tooltip. */
  data?: Record<string, unknown>;
}

/** A patch for `updateMarker` — any input field except the id. */
export type MarkerPatch = Omit<MarkerInput, 'id'>;

/** Payload for a marker click/hover. `screenX/Y` are canvas-relative CSS px. */
export interface MarkerEvent {
  marker: ResolvedMarker;
  /** World (native-pixel) position under the pointer. */
  worldX: number;
  worldY: number;
  /** Canvas-relative CSS-pixel position of the pointer. */
  screenX: number;
  screenY: number;
  originalEvent: MouseEvent;
}

/**
 * Marker interaction callbacks. Settable after construction (so a React wrapper
 * can swap fresh closures each render without rebuilding the viewer) and also
 * acceptable as constructor options. `onMarkerHover` fires on hover *change* with
 * the topmost marker (or null on leave); `onMarkerClick` on a non-drag click;
 * `markerTooltip` drives the built-in popup (return null to suppress it).
 */
export interface MarkerHandlers {
  onMarkerClick?: (e: MarkerEvent) => void;
  onMarkerHover?: (e: MarkerEvent | null) => void;
  markerTooltip?: (m: ResolvedMarker) => string | HTMLElement | null;
}

/** A fully-resolved marker: a fixed world position + a concrete style. */
export interface ResolvedMarker {
  readonly id: string;
  /** Resolved world (native-pixel) position. */
  readonly x: number;
  readonly y: number;
  /** ICRS sky position (deg) if known (sky input, or pixel input with a WCS). */
  readonly ra: number | null;
  readonly dec: number | null;
  readonly shape: MarkerShape;
  readonly size: number;
  readonly color: ColorTuple;
  readonly edgeWidth: number;
  readonly data: Record<string, unknown>;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

const HEX_RE = /^[0-9a-f]+$/;

/** A small pure name->rgb table — the CSV (SSG) path is the most likely to use names. */
const NAMED_COLORS: Record<string, readonly [number, number, number]> = {
  red: [1, 0, 0],
  green: [0, 0.5, 0],
  lime: [0, 1, 0],
  blue: [0, 0, 1],
  cyan: [0, 1, 1],
  aqua: [0, 1, 1],
  magenta: [1, 0, 1],
  fuchsia: [1, 0, 1],
  yellow: [1, 1, 0],
  orange: [1, 0.647, 0],
  white: [1, 1, 1],
  black: [0, 0, 0],
  gray: [0.5, 0.5, 0.5],
  grey: [0.5, 0.5, 0.5],
};

function parseHexColor(s: string): ColorTuple | null {
  let h = s.trim();
  if (h.charAt(0) !== '#') return null;
  h = h.slice(1).toLowerCase();
  // #rgb / #rgba -> expand each nibble to a byte.
  if (h.length === 3 || h.length === 4) {
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  }
  if ((h.length !== 6 && h.length !== 8) || !HEX_RE.test(h)) return null;
  const byte = (i: number): number => parseInt(h.slice(i, i + 2), 16) / 255;
  const a = h.length === 8 ? byte(6) : 1;
  return [byte(0), byte(2), byte(4), a];
}

/**
 * Parse a colour input to an RGBA tuple in [0,1], or null if it cannot be parsed
 * (an unknown name or malformed hex). Pure — no DOM/canvas — so it unit-tests
 * under Node and stays usable in a worker. Accepts `#rgb`/`#rgba`/`#rrggbb`/
 * `#rrggbbaa`, a small set of named colours, or an `[r,g,b(,a)]` tuple.
 */
export function parseColor(input: ColorInput): ColorTuple | null {
  if (typeof input !== 'string') {
    if (input.length < 3) return null;
    const a = input.length >= 4 ? input[3] : 1;
    if (!isFiniteNum(input[0]) || !isFiniteNum(input[1]) || !isFiniteNum(input[2]) || !isFiniteNum(a)) {
      return null;
    }
    return [clamp01(input[0]), clamp01(input[1]), clamp01(input[2]), clamp01(a)];
  }
  const hex = parseHexColor(input);
  if (hex !== null) return hex;
  const named = NAMED_COLORS[input.trim().toLowerCase()];
  if (named !== undefined) return [named[0], named[1], named[2], 1];
  return null;
}

/** True iff `s` is one of the supported shape names. */
export function isMarkerShape(s: string): s is MarkerShape {
  return (MARKER_SHAPES as readonly string[]).includes(s);
}

/**
 * Resolve a marker's world position + sky (if knowable), or null if it cannot be
 * placed. Precedence (tested matrix): WCS present and finite ra/dec -> skyToPix;
 * else finite x/y -> world = (x + 0.5, y + 0.5); else drop. A non-finite
 * projection (e.g. the antipode) also drops.
 */
export function resolveMarkerWorld(
  input: MarkerInput,
  wcs: TanWcs | null,
): { x: number; y: number; ra: number | null; dec: number | null } | null {
  const hasSky = isFiniteNum(input.ra) && isFiniteNum(input.dec);
  const hasPix = isFiniteNum(input.x) && isFiniteNum(input.y);
  if (wcs !== null && hasSky) {
    const p = skyToPix(wcs, input.ra as number, input.dec as number);
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    return { x: p.x, y: p.y, ra: input.ra as number, dec: input.dec as number };
  }
  if (hasPix) {
    const x = (input.x as number) + 0.5;
    const y = (input.y as number) + 0.5;
    const sky = wcs !== null ? pixToSky(wcs, x, y) : null;
    return { x, y, ra: sky?.ra ?? null, dec: sky?.dec ?? null };
  }
  return null;
}

let autoIdCounter = 0;

/**
 * The marker store: resolves and holds a dense, insertion-ordered array of
 * drawable `ResolvedMarker`s (the render/grid/hit-test index space). Markers that
 * cannot be placed (sky input with no WCS, or a non-finite projection) are
 * dropped — their id is still returned by `add` so callers can key by it, but a
 * later `update`/`remove` on a dropped id is a no-op returning false.
 *
 * Mutation costs: `update` of an existing marker is O(1) when only its style
 * changes (the hot React restyle path) — the caller patches a single instance
 * slot. A position change or `add`/`remove`/`replace` is O(n) (a re-pack + grid
 * rebuild), which the viewer drives.
 */
export class MarkerStore {
  private readonly markers: ResolvedMarker[] = [];
  /** Parallel array of the original inputs, kept so `update` can merge a patch. */
  private readonly inputs: MarkerInput[] = [];
  private readonly idToIndex = new Map<string, number>();
  private maxSizeValue = 0;
  private warnedDrop = false;
  private warnedColor = false;
  private warnedShape = false;

  /** Number of drawable markers. */
  get count(): number {
    return this.markers.length;
  }

  /** Largest marker `size` (CSS px) over drawable markers; an upper bound after restyles. */
  get maxSize(): number {
    return this.maxSizeValue;
  }

  /** Drawable markers in draw order (index = instance index = z-order). */
  list(): readonly ResolvedMarker[] {
    return this.markers;
  }

  get(id: string): ResolvedMarker | undefined {
    const i = this.idToIndex.get(id);
    return i === undefined ? undefined : this.markers[i];
  }

  /** The resolved marker at a drawable index (used by hit-testing). */
  at(index: number): ResolvedMarker | undefined {
    return this.markers[index];
  }

  /**
   * Append markers. Returns the resolved id of every input in order (auto-filled
   * where omitted), so a caller can address even auto-id markers. Throws on a
   * duplicate id (within the batch or against existing markers) — a silent
   * replace would hide caller bugs. Dropped (unplaceable) markers warn once.
   */
  add(inputs: MarkerInput[], wcs: TanWcs | null): string[] {
    const ids: string[] = [];
    const seen = new Set<string>();
    // First pass: assign ids and reject duplicates before mutating anything.
    for (const input of inputs) {
      const id = input.id ?? `m${(autoIdCounter++).toString(36)}`;
      if (seen.has(id) || this.idToIndex.has(id)) {
        throw new Error(`MarkerStore: duplicate marker id "${id}"`);
      }
      seen.add(id);
      ids.push(id);
    }
    // Second pass: resolve + store the placeable ones.
    let dropped = false;
    inputs.forEach((input, k) => {
      const id = ids[k] as string;
      const resolved = this.build(id, input, wcs);
      if (resolved === null) {
        dropped = true;
        return;
      }
      this.idToIndex.set(id, this.markers.length);
      this.markers.push(resolved);
      this.inputs.push({ ...input, id });
    });
    this.recomputeMaxSize();
    if (dropped && !this.warnedDrop) {
      this.warnedDrop = true;
      console.warn(
        'FitsViewer overlay: dropped marker(s) that could not be placed ' +
          '(sky position with no WCS, or a non-finite projection).',
      );
    }
    return ids;
  }

  /** Replace the entire set (clear + add). Returns the new ids. */
  replace(inputs: MarkerInput[], wcs: TanWcs | null): string[] {
    this.clear();
    return this.add(inputs, wcs);
  }

  /**
   * Patch one marker by id. Returns `{ index, positionChanged }` for the caller
   * to update the GPU instance (and the grid if the position moved), or null if
   * the id is unknown or the patch would move the marker off-projection (in which
   * case the marker is left unchanged).
   */
  update(
    id: string,
    patch: MarkerPatch,
    wcs: TanWcs | null,
  ): { index: number; positionChanged: boolean } | null {
    const index = this.idToIndex.get(id);
    if (index === undefined) return null;
    const merged: MarkerInput = { ...this.inputs[index], ...patch, id };
    const resolved = this.build(id, merged, wcs);
    if (resolved === null) return null; // unplaceable patch: ignore it
    const prev = this.markers[index] as ResolvedMarker;
    const positionChanged = resolved.x !== prev.x || resolved.y !== prev.y;
    this.markers[index] = resolved;
    this.inputs[index] = merged;
    // maxSize is allowed to be an upper bound after a restyle (only ever grows
    // here) — an over-estimate only widens the hit-test broad phase, never drops
    // a hit. It is made exact again on the next add/remove/replace.
    if (resolved.size > this.maxSizeValue) this.maxSizeValue = resolved.size;
    return { index, positionChanged };
  }

  /** Remove one marker by id. Returns whether it existed. */
  remove(id: string): boolean {
    const index = this.idToIndex.get(id);
    if (index === undefined) return false;
    this.markers.splice(index, 1);
    this.inputs.splice(index, 1);
    this.idToIndex.delete(id);
    // Re-index everything after the removed slot (insertion order preserved).
    for (let i = index; i < this.inputs.length; i++) {
      this.idToIndex.set(this.inputs[i].id as string, i);
    }
    this.recomputeMaxSize();
    return true;
  }

  /** Remove all markers. */
  clear(): void {
    this.markers.length = 0;
    this.inputs.length = 0;
    this.idToIndex.clear();
    this.maxSizeValue = 0;
  }

  private build(id: string, input: MarkerInput, wcs: TanWcs | null): ResolvedMarker | null {
    const world = resolveMarkerWorld(input, wcs);
    if (world === null) return null;
    let shape = DEFAULT_MARKER_SHAPE;
    if (input.shape !== undefined) {
      if (isMarkerShape(input.shape)) {
        shape = input.shape;
      } else if (!this.warnedShape) {
        this.warnedShape = true;
        console.warn(`FitsViewer overlay: unknown marker shape; using "${DEFAULT_MARKER_SHAPE}".`);
      }
    }
    let color = DEFAULT_MARKER_COLOR;
    if (input.color !== undefined) {
      const parsed = parseColor(input.color);
      if (parsed !== null) {
        color = parsed;
      } else if (!this.warnedColor) {
        this.warnedColor = true;
        console.warn('FitsViewer overlay: unparseable marker colour; using the default.');
      }
    }
    const size = isFiniteNum(input.size) && input.size > 0 ? input.size : DEFAULT_MARKER_SIZE;
    const edgeWidth = isFiniteNum(input.edgeWidth) && input.edgeWidth >= 0 ? input.edgeWidth : DEFAULT_MARKER_EDGE;
    return {
      id,
      x: world.x,
      y: world.y,
      ra: world.ra,
      dec: world.dec,
      shape,
      size,
      color,
      edgeWidth,
      data: input.data ?? {},
    };
  }

  private recomputeMaxSize(): void {
    let m = 0;
    for (const marker of this.markers) if (marker.size > m) m = marker.size;
    this.maxSizeValue = m;
  }
}
