/**
 * Pure camera math for the viewer — no DOM, no GL, fully unit-testable.
 *
 * World coordinates are native-resolution image pixels with (0, 0) at the
 * top-left, x increasing right and y increasing down (matching both the FITS
 * row/column convention used by the pyramid and the browser's screen-pixel
 * convention, so no axis flip is needed here — the clip-space Y flip lives in
 * the viewer's NDC conversion).
 *
 * Camera state:
 *   - center: the world point shown at the centre of the viewport.
 *   - zoom:   screen (drawing-buffer) pixels per world pixel. 1.0 = native.
 *
 * The transforms are exact inverses, and `zoomAt` keeps the world point under a
 * given screen position fixed — both properties the tests assert.
 */

export interface Point {
  x: number;
  y: number;
}

/** Axis-aligned world rectangle, x0/y0 = top-left, x1/y1 = bottom-right. */
export interface WorldBounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export class Camera {
  centerX: number;
  centerY: number;
  zoom: number;
  viewportWidth: number;
  viewportHeight: number;
  /** Clamp bounds for zoom; set by the viewer from canvas + image size. */
  minZoom = Number.MIN_VALUE;
  maxZoom = Number.POSITIVE_INFINITY;

  constructor(
    viewportWidth: number,
    viewportHeight: number,
    centerX = 0,
    centerY = 0,
    zoom = 1,
  ) {
    this.viewportWidth = viewportWidth;
    this.viewportHeight = viewportHeight;
    this.centerX = centerX;
    this.centerY = centerY;
    this.zoom = zoom;
  }

  setViewport(width: number, height: number): void {
    this.viewportWidth = width;
    this.viewportHeight = height;
  }

  setZoomLimits(minZoom: number, maxZoom: number): void {
    this.minZoom = minZoom;
    // Keep the range coherent: if a caller's "fit whole image" floor exceeds the
    // zoom-in ceiling (a mosaic far smaller than the viewport), never invert the
    // bounds — an inverted range would pin clampZoom to the wrong limit and make
    // fitToImage unreachable. Raise the ceiling to the floor instead.
    this.maxZoom = Math.max(minZoom, maxZoom);
    this.zoom = this.clampZoom(this.zoom);
  }

  clampZoom(zoom: number): number {
    return Math.min(this.maxZoom, Math.max(this.minZoom, zoom));
  }

  /** World pixel -> screen (drawing-buffer) pixel. */
  worldToScreen(worldX: number, worldY: number): Point {
    return {
      x: (worldX - this.centerX) * this.zoom + this.viewportWidth / 2,
      y: (worldY - this.centerY) * this.zoom + this.viewportHeight / 2,
    };
  }

  /** Screen (drawing-buffer) pixel -> world pixel. Inverse of worldToScreen. */
  screenToWorld(screenX: number, screenY: number): Point {
    return {
      x: (screenX - this.viewportWidth / 2) / this.zoom + this.centerX,
      y: (screenY - this.viewportHeight / 2) / this.zoom + this.centerY,
    };
  }

  /** Pan by a screen-pixel delta (e.g. a mouse drag), keeping content under the cursor. */
  panByScreen(dxScreen: number, dyScreen: number): void {
    this.centerX -= dxScreen / this.zoom;
    this.centerY -= dyScreen / this.zoom;
  }

  /** Set zoom (clamped), centre unchanged. */
  setZoom(zoom: number): void {
    this.zoom = this.clampZoom(zoom);
  }

  /**
   * Zoom to `newZoom` (clamped) while holding the world point currently under
   * (screenX, screenY) fixed at that same screen position — anchored zoom.
   */
  zoomAt(screenX: number, screenY: number, newZoom: number): void {
    const anchor = this.screenToWorld(screenX, screenY);
    this.zoom = this.clampZoom(newZoom);
    this.centerX = anchor.x - (screenX - this.viewportWidth / 2) / this.zoom;
    this.centerY = anchor.y - (screenY - this.viewportHeight / 2) / this.zoom;
  }

  /** World-space rectangle currently visible in the viewport. */
  worldBounds(): WorldBounds {
    const tl = this.screenToWorld(0, 0);
    const br = this.screenToWorld(this.viewportWidth, this.viewportHeight);
    return { x0: tl.x, y0: tl.y, x1: br.x, y1: br.y };
  }
}
