/**
 * Region model + store (issue #16) — pure, no GL, no DOM.
 *
 * A *region* is the second overlay glyph class, distinct from the point/circle/box
 * markers in `markers.ts`. Where a marker is CSS-px sized and screen-aligned (it
 * never rotates and never scales with zoom), a region is **world-sized and
 * rotatable**: it occupies a real on-sky footprint, so it scales with zoom and
 * turns with the display orientation (a shutter keeps its true angular size and
 * position angle on rotated, non-N-up native pixels). This drives CAMPFIRE MSA
 * shutters and is reusable for NIRSpec pointing footprints, NIRCam tile
 * boundaries, and DS9-style regions.
 *
 * Two shapes:
 *   - `rect`    — a rotatable rectangle (center + half-extents + orientation).
 *                 Instanced on the GPU (a field can have thousands of shutters).
 *   - `polygon` — an arbitrary world-space polygon (footprints). A separate,
 *                 non-instanced path (triangulated fill + expanded stroke).
 *
 * Like `MarkerStore`, this module resolves every region to a fixed *world*
 * (native-pixel) geometry ONCE, so rendering and hit-testing are view-independent
 * — pan/zoom/North-up only change uniforms, never the region data.
 *
 * Geometry inputs (both accepted; the store resolves either to world space):
 *   - SKY   — `ra`/`dec` (+ `paDeg`, angular size in arcsec) for a rect, or
 *             `vertices: {ra,dec}[]` for a polygon. Requires a usable WCS.
 *   - WORLD — `x`/`y` (+ `width`/`height` in world px, `rotationDeg`) for a rect,
 *             or `worldVertices: {x,y}[]` for a polygon.
 *
 * Coordinate + angle conventions (deliberate, tested in regions.test.ts):
 *   - `ra`/`dec` are ICRS degrees and go through `skyToPix` (astropy-gated).
 *   - `x`/`y`/`worldVertices` are 0-based ARRAY pixels (the fitsgl catalog
 *     convention), so array pixel k maps to world `k + 0.5` — identical to
 *     markers, so a world region and the sky region at the same array pixel land
 *     on the same world point.
 *   - `paDeg` is the position angle of the rect's *height* (`axisV`) axis, in
 *     degrees **East of North** (the astronomy convention). 0 → the height axis
 *     points North; increasing PA rotates it toward East.
 *   - `rotationDeg` (world rect) is a CCW rotation in the world-pixel frame: 0 →
 *     `axisU = (1,0)`, `axisV = (0,1)` (axis-aligned).
 *   - `width`/`height` (world rect) and angular sizes are FULL extents, not half.
 */

import { skyToPix, type TanWcs } from '../wcs/tan.js';
import { parseColor, type ColorInput, type ColorTuple } from './markers.js';

/** The two region shapes. */
export const REGION_SHAPES = ['rect', 'polygon'] as const;
export type RegionShape = (typeof REGION_SHAPES)[number];

/** Default region style — a visible amber stroke, no fill, solid, 1.5px. */
export const DEFAULT_REGION_STROKE: ColorTuple = [1, 0.8, 0, 1];
/** Default fill: fully transparent (a region is an outline unless the caller fills it). */
export const DEFAULT_REGION_FILL: ColorTuple = [0, 0, 0, 0];
export const DEFAULT_REGION_STROKE_WIDTH = 1.5; // CSS px, screen-constant

/** A world (native-pixel) point. */
export interface RegionPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * A region as supplied by a caller. One flat shape (mirroring `MarkerInput`):
 * the geometry fields present select the shape + coordinate system.
 *   - `vertices`/`worldVertices` present → a polygon (else a rect).
 *   - `ra`/`dec` (or sky `vertices`) present with a WCS → sky geometry; else the
 *     world-pixel fields are used.
 */
export interface RegionInput {
  /** Caller id; auto-assigned if omitted. Must be unique within the store. */
  id?: string;
  /** Explicit shape; inferred from the geometry fields when omitted. */
  shape?: RegionShape;

  // --- rect geometry: sky ---
  /** ICRS sky centre (deg). The primary rect path; requires a usable WCS. */
  ra?: number;
  dec?: number;
  /** Position angle of the height axis, degrees East of North (default 0). */
  paDeg?: number;
  /** Full angular extents (arcsec) along the width / height axes. */
  widthArcsec?: number;
  heightArcsec?: number;

  // --- rect geometry: world px ---
  /** 0-based array-pixel centre (world = x + 0.5). Used when `ra`/`dec` absent. */
  x?: number;
  y?: number;
  /** Full extents in world (native) px. */
  width?: number;
  height?: number;
  /** CCW rotation in the world-pixel frame, degrees (default 0). */
  rotationDeg?: number;

  // --- polygon geometry ---
  /** ICRS sky vertices (deg). Selects a polygon; requires a usable WCS. */
  vertices?: ReadonlyArray<{ ra: number; dec: number }>;
  /** 0-based array-pixel vertices (world = x + 0.5). Selects a polygon. */
  worldVertices?: ReadonlyArray<{ x: number; y: number }>;

  // --- style ---
  /** Fill colour (RGBA; alpha via tuple/`#rrggbbaa`). Omit for no fill. */
  fill?: ColorInput;
  /** Stroke colour. Defaults to amber. */
  stroke?: ColorInput;
  /** Stroke width in CSS px (screen-constant, like a marker edge). */
  strokeWidth?: number;
  /** Dash pattern `[on, off]` in CSS px; omit or `[0, 0]` for a solid stroke. */
  dash?: readonly [number, number];
  /** Arbitrary per-region payload, surfaced on hover/click and in the tooltip. */
  data?: Record<string, unknown>;
}

/** A patch for `updateRegion` — any input field except the id. */
export type RegionPatch = Omit<RegionInput, 'id'>;

/** Payload for a region click/hover. `screenX/Y` are canvas-relative CSS px. */
export interface RegionEvent {
  region: ResolvedRegion;
  /** World (native-pixel) position under the pointer. */
  worldX: number;
  worldY: number;
  /** Canvas-relative CSS-pixel position of the pointer. */
  screenX: number;
  screenY: number;
  originalEvent: MouseEvent;
}

/**
 * Region interaction callbacks (mirror of `MarkerHandlers`). Settable after
 * construction so a React wrapper can swap fresh closures each render. Hover fires
 * on hover *change* with the topmost region (or null on leave); click on a
 * non-drag click; `regionTooltip` drives the shared popup (return null to suppress).
 */
export interface RegionHandlers {
  onRegionClick?: (e: RegionEvent) => void;
  onRegionHover?: (e: RegionEvent | null) => void;
  regionTooltip?: (r: ResolvedRegion) => string | HTMLElement | null;
}

/** Fields every resolved region carries (style + broad-phase centre/extent). */
interface ResolvedRegionBase {
  readonly id: string;
  readonly fill: ColorTuple;
  readonly stroke: ColorTuple;
  /** Stroke width, CSS px (screen-constant). */
  readonly strokeWidth: number;
  /** Dash on/off lengths, CSS px. `dashOn === 0` means a solid stroke. */
  readonly dashOn: number;
  readonly dashOff: number;
  readonly data: Record<string, unknown>;
  /** Broad-phase centre (rect centre / polygon centroid), world px. */
  readonly centerX: number;
  readonly centerY: number;
  /** Circumradius from the centre over the geometry, world px (broad-phase). */
  readonly boundRadius: number;
}

/** A resolved rotatable rectangle: centre + world half-extents + an orthonormal basis. */
export interface ResolvedRect extends ResolvedRegionBase {
  readonly shape: 'rect';
  readonly halfW: number;
  readonly halfH: number;
  /** Unit world-space direction of the +width (`axisU`) and +height (`axisV`) axes. */
  readonly axisU: readonly [number, number];
  readonly axisV: readonly [number, number];
}

/** A resolved polygon: world vertices (already projected from sky if that was the input). */
export interface ResolvedPolygon extends ResolvedRegionBase {
  readonly shape: 'polygon';
  readonly worldVertices: ReadonlyArray<RegionPoint>;
}

export type ResolvedRegion = ResolvedRect | ResolvedPolygon;

const DEG = Math.PI / 180;
const ARCSEC_PER_DEG = 3600;

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** True iff `s` is a supported region shape. */
export function isRegionShape(s: string): s is RegionShape {
  return (REGION_SHAPES as readonly string[]).includes(s);
}

/** The shape a region input resolves to: explicit `shape`, else inferred from geometry. */
export function inferRegionShape(input: RegionInput): RegionShape {
  if (input.shape !== undefined && isRegionShape(input.shape)) return input.shape;
  if (input.vertices !== undefined || input.worldVertices !== undefined) return 'polygon';
  return 'rect';
}

/**
 * A local sky basis at `(ra, dec)`, in world px: the centre, the unit North
 * direction, a unit East-ish direction perpendicular to North (handedness taken
 * from the WCS), and the world px per degree. Returns null on a non-finite
 * projection (e.g. the antipode) or a degenerate scale.
 */
function skyBasis(
  wcs: TanWcs,
  ra: number,
  dec: number,
): {
  cx: number;
  cy: number;
  nHat: readonly [number, number];
  ePerp: readonly [number, number];
  pixPerDeg: number;
} | null {
  const eps = 1e-4; // deg; direction-only, magnitude not critical
  const c = skyToPix(wcs, ra, dec);
  if (!Number.isFinite(c.x) || !Number.isFinite(c.y)) return null;

  // +Dec (North) direction in world px.
  const pN = skyToPix(wcs, ra, dec + eps);
  const nx = pN.x - c.x;
  const ny = pN.y - c.y;
  const nLen = Math.hypot(nx, ny);
  if (!(nLen > 0) || !Number.isFinite(nLen)) return null;
  const nHat: readonly [number, number] = [nx / nLen, ny / nLen];
  const pixPerDeg = nLen / eps;

  // +RA (East) direction: fixes the handedness of the perpendicular AND lets us
  // assert the frame is square-pixel (see below).
  const cosDec = Math.cos(dec * DEG);
  const dRa = Math.abs(cosDec) > 1e-8 ? eps / cosDec : eps;
  const pE = skyToPix(wcs, ra + dRa, dec);
  const ex = pE.x - c.x;
  const ey = pE.y - c.y;
  const eLen = Math.hypot(ex, ey);
  if (!(eLen > 0) || !Number.isFinite(eLen)) return null;

  // A sky RECT is sized from a single (North) pixel scale with orthonormal axes, so
  // it is only faithful on a *square-pixel* WCS: the local North and East pixel
  // scales must match and be perpendicular. That holds for the ICRS+TAN square-pixel
  // mosaics fitsgl builds (SIP/TPV are already rejected upstream); rather than
  // silently drawing a wrongly-sized footprint on an anisotropic or sheared frame,
  // reject it here so the caller drops the region and warns. (Sky *polygons* project
  // each vertex independently and are unaffected, so this guard is rect-only.)
  const eastPerDeg = eLen / dRa;
  const scaleSkew = Math.abs(eastPerDeg - pixPerDeg) / pixPerDeg;
  const perpCos = Math.abs((nHat[0] * ex + nHat[1] * ey) / eLen); // |cos∠(N, E)|
  if (scaleSkew > 1e-2 || perpCos > 1e-2) return null;

  // Rotating North +90° CCW gives one perpendicular; pick the sense pointing East.
  const ccw: readonly [number, number] = [-nHat[1], nHat[0]];
  const eastIsCcw = ccw[0] * ex + ccw[1] * ey >= 0;
  const ePerp: readonly [number, number] = eastIsCcw ? ccw : [-ccw[0], -ccw[1]];
  return { cx: c.x, cy: c.y, nHat, ePerp, pixPerDeg };
}

function rectFrom(
  id: string,
  centerX: number,
  centerY: number,
  halfW: number,
  halfH: number,
  axisU: readonly [number, number],
  axisV: readonly [number, number],
  style: ResolvedStyle,
): ResolvedRect {
  return {
    id,
    shape: 'rect',
    ...style,
    centerX,
    centerY,
    boundRadius: Math.hypot(halfW, halfH),
    halfW,
    halfH,
    axisU,
    axisV,
  };
}

/** Resolve a rect input (sky or world) to fixed world geometry, or null if unplaceable. */
export function resolveRect(input: RegionInput, wcs: TanWcs | null, style: ResolvedStyle, id: string): ResolvedRect | null {
  const hasSky = isFiniteNum(input.ra) && isFiniteNum(input.dec);
  const hasWorld = isFiniteNum(input.x) && isFiniteNum(input.y);
  if (wcs !== null && hasSky) {
    const basis = skyBasis(wcs, input.ra as number, input.dec as number);
    if (basis === null) return null;
    const pa = (input.paDeg ?? 0) * DEG;
    const cosPa = Math.cos(pa);
    const sinPa = Math.sin(pa);
    // Height axis: PA measured from North toward East. Width axis ⟂ (rot -90°).
    const axisV: readonly [number, number] = [
      cosPa * basis.nHat[0] + sinPa * basis.ePerp[0],
      cosPa * basis.nHat[1] + sinPa * basis.ePerp[1],
    ];
    const axisU: readonly [number, number] = [axisV[1], -axisV[0]];
    const wArc = isFiniteNum(input.widthArcsec) ? Math.max(0, input.widthArcsec) : 0;
    const hArc = isFiniteNum(input.heightArcsec) ? Math.max(0, input.heightArcsec) : 0;
    const scale = basis.pixPerDeg / ARCSEC_PER_DEG; // world px per arcsec
    return rectFrom(id, basis.cx, basis.cy, (wArc / 2) * scale, (hArc / 2) * scale, axisU, axisV, style);
  }
  if (hasWorld) {
    const cx = (input.x as number) + 0.5;
    const cy = (input.y as number) + 0.5;
    const theta = (input.rotationDeg ?? 0) * DEG;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const w = isFiniteNum(input.width) ? Math.max(0, input.width) : 0;
    const h = isFiniteNum(input.height) ? Math.max(0, input.height) : 0;
    return rectFrom(id, cx, cy, w / 2, h / 2, [cos, sin], [-sin, cos], style);
  }
  return null;
}

/** Resolve a polygon input (sky or world) to world vertices, or null if unplaceable. */
export function resolvePolygon(
  input: RegionInput,
  wcs: TanWcs | null,
  style: ResolvedStyle,
  id: string,
): ResolvedPolygon | null {
  let verts: RegionPoint[] | null = null;
  if (wcs !== null && input.vertices !== undefined) {
    verts = [];
    for (const v of input.vertices) {
      if (!isFiniteNum(v.ra) || !isFiniteNum(v.dec)) return null;
      const p = skyToPix(wcs, v.ra, v.dec);
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
      verts.push({ x: p.x, y: p.y });
    }
  } else if (input.worldVertices !== undefined) {
    verts = [];
    for (const v of input.worldVertices) {
      if (!isFiniteNum(v.x) || !isFiniteNum(v.y)) return null;
      verts.push({ x: v.x + 0.5, y: v.y + 0.5 });
    }
  }
  if (verts === null || verts.length < 3) return null;
  let sx = 0;
  let sy = 0;
  for (const v of verts) {
    sx += v.x;
    sy += v.y;
  }
  const cx = sx / verts.length;
  const cy = sy / verts.length;
  let boundRadius = 0;
  for (const v of verts) {
    const d = Math.hypot(v.x - cx, v.y - cy);
    if (d > boundRadius) boundRadius = d;
  }
  return { id, shape: 'polygon', ...style, centerX: cx, centerY: cy, boundRadius, worldVertices: verts };
}

/** The resolved style block shared by rect + polygon. */
export interface ResolvedStyle {
  fill: ColorTuple;
  stroke: ColorTuple;
  strokeWidth: number;
  dashOn: number;
  dashOff: number;
  data: Record<string, unknown>;
}

let autoIdCounter = 0;

/**
 * The region store: resolves and holds a dense, insertion-ordered array of
 * drawable `ResolvedRegion`s (render/grid/hit-test index space). Mirrors
 * `MarkerStore` — a style-only `update` is O(1) (patch one slot), a geometry
 * change or add/remove/replace is O(n). Regions that cannot be placed (sky input
 * with no WCS, a non-finite projection, or a polygon with < 3 vertices) are
 * dropped; their id is still returned by `add` (so callers can key by it), but a
 * later `update`/`remove` on a dropped id is a no-op.
 */
export class RegionStore {
  private readonly regions: ResolvedRegion[] = [];
  private readonly inputs: RegionInput[] = [];
  private readonly idToIndex = new Map<string, number>();
  private maxBoundValue = 0;
  private warnedDrop = false;
  private warnedColor = false;

  get count(): number {
    return this.regions.length;
  }

  /** Largest region bound-radius (world px) over drawable regions; the broad-phase
   *  query radius the viewer must use so a big region is never culled. An upper
   *  bound after a style-only restyle (never shrinks there); exact after add/remove. */
  get maxBoundRadius(): number {
    return this.maxBoundValue;
  }

  /** Drawable regions in draw order (index = z-order). */
  list(): readonly ResolvedRegion[] {
    return this.regions;
  }

  /** Just the rects, with their store index (the instanced GPU path). */
  rects(): Array<{ index: number; rect: ResolvedRect }> {
    const out: Array<{ index: number; rect: ResolvedRect }> = [];
    this.regions.forEach((r, index) => {
      if (r.shape === 'rect') out.push({ index, rect: r });
    });
    return out;
  }

  /** Just the polygons, with their store index (the per-polygon GPU path). */
  polygons(): Array<{ index: number; polygon: ResolvedPolygon }> {
    const out: Array<{ index: number; polygon: ResolvedPolygon }> = [];
    this.regions.forEach((r, index) => {
      if (r.shape === 'polygon') out.push({ index, polygon: r });
    });
    return out;
  }

  get(id: string): ResolvedRegion | undefined {
    const i = this.idToIndex.get(id);
    return i === undefined ? undefined : this.regions[i];
  }

  /** The resolved region at a drawable index (used by hit-testing). */
  at(index: number): ResolvedRegion | undefined {
    return this.regions[index];
  }

  /**
   * Append regions. Returns the resolved id of every input in order (auto-filled
   * where omitted). Throws on a duplicate id (within the batch or against existing
   * regions). Dropped (unplaceable) regions warn once.
   */
  add(inputs: RegionInput[], wcs: TanWcs | null): string[] {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const input of inputs) {
      const id = input.id ?? `r${(autoIdCounter++).toString(36)}`;
      if (seen.has(id) || this.idToIndex.has(id)) {
        throw new Error(`RegionStore: duplicate region id "${id}"`);
      }
      seen.add(id);
      ids.push(id);
    }
    let dropped = false;
    inputs.forEach((input, k) => {
      const id = ids[k] as string;
      const resolved = this.build(id, input, wcs);
      if (resolved === null) {
        dropped = true;
        return;
      }
      this.idToIndex.set(id, this.regions.length);
      this.regions.push(resolved);
      this.inputs.push({ ...input, id });
    });
    this.recomputeMaxBound();
    if (dropped && !this.warnedDrop) {
      this.warnedDrop = true;
      console.warn(
        'FitsViewer overlay: dropped region(s) that could not be placed ' +
          '(sky geometry with no WCS, a non-finite projection, a non-square-pixel ' +
          'WCS for a sky rect, or a polygon with < 3 vertices).',
      );
    }
    return ids;
  }

  /** Replace the entire set (clear + add). Returns the new ids. */
  replace(inputs: RegionInput[], wcs: TanWcs | null): string[] {
    this.clear();
    return this.add(inputs, wcs);
  }

  /**
   * Patch one region by id. Returns `{ index, geometryChanged, shapeChanged }` for
   * the caller to update the GPU buffers (and the grid if geometry moved), or null
   * if the id is unknown or the patch would make the region unplaceable (in which
   * case it is left unchanged). `shapeChanged` is true when the patch flips
   * rect↔polygon (the caller must rebuild both GPU paths, not patch one slot).
   */
  update(
    id: string,
    patch: RegionPatch,
    wcs: TanWcs | null,
  ): { index: number; geometryChanged: boolean; shapeChanged: boolean } | null {
    const index = this.idToIndex.get(id);
    if (index === undefined) return null;
    const merged: RegionInput = { ...this.inputs[index], ...patch, id };
    // A geometry patch supersedes the other coordinate family. Without this, a
    // stale `ra`/`dec` (or sky `vertices`) surviving from the original input would
    // keep resolve*() on the sky branch and silently ignore a world-pixel patch
    // (and vice versa). Switching families requires supplying the new anchor
    // (`x`/`y`, `ra`/`dec`, or the vertex list); a size-only patch stays in the
    // region's current family.
    if (patch.x !== undefined || patch.y !== undefined) {
      merged.ra = undefined;
      merged.dec = undefined;
    }
    if (patch.ra !== undefined || patch.dec !== undefined) {
      merged.x = undefined;
      merged.y = undefined;
    }
    if (patch.worldVertices !== undefined) merged.vertices = undefined;
    if (patch.vertices !== undefined) merged.worldVertices = undefined;
    const resolved = this.build(id, merged, wcs);
    if (resolved === null) return null;
    const prev = this.regions[index] as ResolvedRegion;
    const shapeChanged = resolved.shape !== prev.shape;
    const geometryChanged = shapeChanged || !sameGeometry(prev, resolved);
    this.regions[index] = resolved;
    this.inputs[index] = merged;
    // Grow the bound eagerly (keeps the broad phase a superset after a restyle);
    // it is made exact again on the next add/remove.
    if (resolved.boundRadius > this.maxBoundValue) this.maxBoundValue = resolved.boundRadius;
    return { index, geometryChanged, shapeChanged };
  }

  /** Remove one region by id. Returns whether it existed. */
  remove(id: string): boolean {
    const index = this.idToIndex.get(id);
    if (index === undefined) return false;
    this.regions.splice(index, 1);
    this.inputs.splice(index, 1);
    this.idToIndex.delete(id);
    for (let i = index; i < this.inputs.length; i++) {
      this.idToIndex.set(this.inputs[i].id as string, i);
    }
    this.recomputeMaxBound();
    return true;
  }

  /** Remove all regions. */
  clear(): void {
    this.regions.length = 0;
    this.inputs.length = 0;
    this.idToIndex.clear();
    this.maxBoundValue = 0;
  }

  private recomputeMaxBound(): void {
    let m = 0;
    for (const r of this.regions) if (r.boundRadius > m) m = r.boundRadius;
    this.maxBoundValue = m;
  }

  private build(id: string, input: RegionInput, wcs: TanWcs | null): ResolvedRegion | null {
    const style = this.resolveStyle(input);
    return inferRegionShape(input) === 'polygon'
      ? resolvePolygon(input, wcs, style, id)
      : resolveRect(input, wcs, style, id);
  }

  private resolveStyle(input: RegionInput): ResolvedStyle {
    let fill = DEFAULT_REGION_FILL;
    let stroke = DEFAULT_REGION_STROKE;
    if (input.fill !== undefined) {
      const parsed = parseColor(input.fill);
      if (parsed !== null) fill = parsed;
      else this.warnColorOnce();
    }
    if (input.stroke !== undefined) {
      const parsed = parseColor(input.stroke);
      if (parsed !== null) stroke = parsed;
      else this.warnColorOnce();
    }
    const strokeWidth =
      isFiniteNum(input.strokeWidth) && input.strokeWidth >= 0
        ? input.strokeWidth
        : DEFAULT_REGION_STROKE_WIDTH;
    let dashOn = 0;
    let dashOff = 0;
    if (input.dash !== undefined && isFiniteNum(input.dash[0]) && isFiniteNum(input.dash[1])) {
      dashOn = Math.max(0, input.dash[0]);
      dashOff = Math.max(0, input.dash[1]);
    }
    return { fill, stroke, strokeWidth, dashOn, dashOff, data: input.data ?? {} };
  }

  private warnColorOnce(): void {
    if (!this.warnedColor) {
      this.warnedColor = true;
      console.warn('FitsViewer overlay: unparseable region colour; using the default.');
    }
  }
}

/** Whether two resolved regions share the same geometry (positions unchanged). */
function sameGeometry(a: ResolvedRegion, b: ResolvedRegion): boolean {
  if (a.shape !== b.shape) return false;
  if (a.shape === 'rect' && b.shape === 'rect') {
    return (
      a.centerX === b.centerX &&
      a.centerY === b.centerY &&
      a.halfW === b.halfW &&
      a.halfH === b.halfH &&
      a.axisU[0] === b.axisU[0] &&
      a.axisU[1] === b.axisU[1] &&
      a.axisV[0] === b.axisV[0] &&
      a.axisV[1] === b.axisV[1]
    );
  }
  if (a.shape === 'polygon' && b.shape === 'polygon') {
    if (a.worldVertices.length !== b.worldVertices.length) return false;
    for (let i = 0; i < a.worldVertices.length; i++) {
      if (a.worldVertices[i].x !== b.worldVertices[i].x || a.worldVertices[i].y !== b.worldVertices[i].y) {
        return false;
      }
    }
    return true;
  }
  return false;
}
