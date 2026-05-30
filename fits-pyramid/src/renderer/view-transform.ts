/**
 * View transform — the world<->screen layer that carries the North-up rotation
 * (decisions D1/D2).
 *
 * The `Camera` stays axis-aligned in world (native-pixel) space; the North-up
 * orientation is a 2×2 matrix applied here, *over* the camera, in screen-pixel
 * space (y-down, before the NDC flip the viewer does). With the identity matrix
 * these functions reduce exactly to the camera's own affine transform, so
 * North-up off is bit-identical to the pre-M2 renderer.
 *
 *   screen = M · ((world − center) · zoom) + viewportCentre
 *   world  = center + (Mᵀ · (screen − viewportCentre)) / zoom      (M orthogonal)
 *
 * Pure math — no GL, no DOM, no `Camera` dependency (it takes the camera's
 * scalar state structurally). Unit-tested in `view-transform.test.ts`, including
 * the orientation against astropy fixtures.
 */

import { pixToSky, skyToPix, type TanWcs } from '../wcs/tan.js';

/** A 2×2 matrix, row-major `[m00, m01, m10, m11]`. */
export type Mat2 = readonly [number, number, number, number];

export const IDENTITY_MAT2: Mat2 = [1, 0, 0, 1];

/** Apply a 2×2 matrix to a vector. */
export function applyMat2(m: Mat2, x: number, y: number): { x: number; y: number } {
  return { x: m[0] * x + m[1] * y, y: m[2] * x + m[3] * y };
}

/** Transpose a 2×2. For an orthogonal matrix (rotation / rotation+flip) this is its inverse. */
export function transposeMat2(m: Mat2): Mat2 {
  return [m[0], m[2], m[1], m[3]];
}

/** The camera scalar state this layer needs (Camera satisfies it structurally). */
export interface ViewParams {
  centerX: number;
  centerY: number;
  zoom: number;
  viewportWidth: number;
  viewportHeight: number;
}

/** World (native pixel) -> screen (drawing-buffer pixel, y-down). */
export function worldToScreen(
  view: ViewParams,
  orient: Mat2,
  worldX: number,
  worldY: number,
): { x: number; y: number } {
  const d = applyMat2(orient, (worldX - view.centerX) * view.zoom, (worldY - view.centerY) * view.zoom);
  return { x: d.x + view.viewportWidth / 2, y: d.y + view.viewportHeight / 2 };
}

/** Screen (drawing-buffer pixel, y-down) -> world. Inverse of `worldToScreen`. */
export function screenToWorld(
  view: ViewParams,
  orient: Mat2,
  screenX: number,
  screenY: number,
): { x: number; y: number } {
  const d = applyMat2(transposeMat2(orient), screenX - view.viewportWidth / 2, screenY - view.viewportHeight / 2);
  return { x: view.centerX + d.x / view.zoom, y: view.centerY + d.y / view.zoom };
}

/**
 * New camera centre after panning by a screen-pixel drag delta under `orient`.
 * The screen delta is mapped to a world delta through Mᵀ (the inverse
 * orientation), so a drag moves the grabbed point with the cursor regardless of
 * rotation. With the identity matrix this is the camera's plain `panByScreen`.
 */
export function panCenter(
  view: ViewParams,
  orient: Mat2,
  dxScreen: number,
  dyScreen: number,
): { centerX: number; centerY: number } {
  const d = applyMat2(transposeMat2(orient), dxScreen, dyScreen);
  return { centerX: view.centerX - d.x / view.zoom, centerY: view.centerY - d.y / view.zoom };
}

/**
 * New camera centre for an anchored zoom about a screen point under `orient`,
 * given the (already-clamped) `newZoom`. Keeps the world point currently under
 * the screen point fixed there — `view.zoom` must still be the OLD zoom so the
 * anchor is taken before the change. With the identity matrix this is the
 * camera's plain `zoomAt`.
 */
export function anchoredZoomCenter(
  view: ViewParams,
  orient: Mat2,
  screenX: number,
  screenY: number,
  newZoom: number,
): { centerX: number; centerY: number } {
  const anchor = screenToWorld(view, orient, screenX, screenY);
  const d = applyMat2(transposeMat2(orient), screenX - view.viewportWidth / 2, screenY - view.viewportHeight / 2);
  return { centerX: anchor.x - d.x / newZoom, centerY: anchor.y - d.y / newZoom };
}

/**
 * Axis-aligned world bounding box of the viewport, from all four screen corners.
 * Under rotation the viewport maps to a rotated world rectangle, so its AABB is
 * larger — `visibleTiles` then slightly over-selects at the corners (a few
 * off-screen fetches), which the roadmap accepts as expected, not a bug.
 */
export function viewportWorldAABB(
  view: ViewParams,
  orient: Mat2,
): { x0: number; y0: number; x1: number; y1: number } {
  const w = view.viewportWidth;
  const h = view.viewportHeight;
  const corners = [
    screenToWorld(view, orient, 0, 0),
    screenToWorld(view, orient, w, 0),
    screenToWorld(view, orient, 0, h),
    screenToWorld(view, orient, w, h),
  ];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const c of corners) {
    if (c.x < x0) x0 = c.x;
    if (c.y < y0) y0 = c.y;
    if (c.x > x1) x1 = c.x;
    if (c.y > y1) y1 = c.y;
  }
  return { x0, y0, x1, y1 };
}

/**
 * Screen-space span (width, height in world-pixels at zoom 1) of an oriented
 * `width × height` image — used to fit the whole rotated image in the viewport.
 * For the identity matrix this is just `{ spanX: width, spanY: height }`.
 */
export function orientedImageSpan(
  orient: Mat2,
  width: number,
  height: number,
): { spanX: number; spanY: number } {
  const hw = width / 2;
  const hh = height / 2;
  const offsets = [
    applyMat2(orient, -hw, -hh),
    applyMat2(orient, hw, -hh),
    applyMat2(orient, -hw, hh),
    applyMat2(orient, hw, hh),
  ];
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const o of offsets) {
    if (o.x < minX) minX = o.x;
    if (o.x > maxX) maxX = o.x;
    if (o.y < minY) minY = o.y;
    if (o.y > maxY) maxY = o.y;
  }
  return { spanX: maxX - minX, spanY: maxY - minY };
}

const DEG = Math.PI / 180;

/**
 * The North-up / East-left orientation matrix for a WCS, evaluated at world
 * point `(centerX, centerY)` (the image centre): the rigid 2×2 that, applied in
 * the view transform, sends +Dec (North) to screen-up and +RA (East) to
 * screen-left. A parity flip is added when the WCS handedness would otherwise
 * put East on the right. Returns the identity if North is undefined here (e.g. a
 * degenerate WCS), so the caller can always apply the result safely.
 */
export function northUpOrientation(wcs: TanWcs, centerX: number, centerY: number): Mat2 {
  const { ra, dec } = pixToSky(wcs, centerX, centerY);
  const eps = 1e-4; // degrees; direction-only, so the magnitude is not critical

  // +Dec direction in world space.
  const pN = skyToPix(wcs, ra, dec + eps);
  const nx = pN.x - centerX;
  const ny = pN.y - centerY;
  const nLen = Math.hypot(nx, ny);
  if (!(nLen > 0) || !Number.isFinite(nLen)) return IDENTITY_MAT2;

  // +RA direction in world space (scaled by 1/cos(dec); direction is what matters).
  const cosDec = Math.cos(dec * DEG);
  const dRa = Math.abs(cosDec) > 1e-8 ? eps / cosDec : eps;
  const pE = skyToPix(wcs, ra + dRa, dec);
  const ex = pE.x - centerX;
  const ey = pE.y - centerY;

  // Rotation that sends the (unit) North vector to screen-up = (0, -1) in y-down
  // screen space: a rotation adds its angle, so theta = -pi/2 - angle(N).
  const aN = Math.atan2(ny, nx);
  const theta = -Math.PI / 2 - aN;
  const c = Math.cos(theta);
  const s = Math.sin(theta);

  // Where does East land after that rotation? If on the right (x > 0), reflect
  // horizontally (negate screen x) to bring East left while keeping North up.
  const eRotX = c * ex - s * ey;
  if (eRotX > 0) {
    // F · R, with F = diag(-1, 1): [[-c, s], [s, c]].
    return [-c, s, s, c];
  }
  // R = [[c, -s], [s, c]].
  return [c, -s, s, c];
}
