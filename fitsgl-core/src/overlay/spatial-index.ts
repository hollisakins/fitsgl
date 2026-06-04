/**
 * Spatial index for marker hit-testing (M3) — pure, no GL/DOM.
 *
 * A uniform grid over the markers' world-space bounding box. It answers the
 * broad phase of picking: `query(x, y, radius)` returns a SUPERSET of every
 * marker whose centre lies within `radius` of `(x, y)` — it may over-return
 * (the narrow phase in `hit-test.ts` then does the exact, screen-space test),
 * but it must never under-return. `spatial-index.test.ts` pins that invariant
 * against a brute-force oracle, including the degenerate cases below.
 *
 * The grid is build-once/immutable: the viewer rebuilds it when the marker SET
 * changes (add/remove/replace, or the rare position-changing update). A
 * style-only `updateMarker` never touches it (positions are unchanged), which is
 * what keeps the common React restyle path cheap.
 *
 * Cell size targets ~1 marker/cell (`sqrt(area / n)`), with the total cell count
 * capped so a few far-flung outliers cannot allocate a huge sparse grid, and a
 * brute-force fallback for tiny/degenerate inputs (a single marker, all-coincident
 * markers, or a zero-area box) where a grid buys nothing.
 */

/** Below this many markers, skip the grid and scan all of them. */
const BRUTE_FORCE_MAX = 64;
/** Cap on total grid cells, so a sparse AABB can't allocate an enormous array. */
const MAX_CELLS = 1 << 20; // ~1M

interface Point {
  readonly x: number;
  readonly y: number;
}

export class GridIndex {
  private readonly n: number;
  private readonly brute: boolean;
  private readonly xs: Float64Array;
  private readonly ys: Float64Array;
  // Grid params (unused when `brute`).
  private minX = 0;
  private minY = 0;
  private cell = 1;
  private cols = 1;
  private rows = 1;
  /** cells[c] = list of marker indices in cell c (row-major). */
  private cells: number[][] = [];

  constructor(points: readonly Point[]) {
    this.n = points.length;
    this.xs = new Float64Array(this.n);
    this.ys = new Float64Array(this.n);
    for (let i = 0; i < this.n; i++) {
      this.xs[i] = points[i].x;
      this.ys[i] = points[i].y;
    }

    if (this.n <= BRUTE_FORCE_MAX) {
      this.brute = true;
      return;
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < this.n; i++) {
      if (this.xs[i] < minX) minX = this.xs[i];
      if (this.xs[i] > maxX) maxX = this.xs[i];
      if (this.ys[i] < minY) minY = this.ys[i];
      if (this.ys[i] > maxY) maxY = this.ys[i];
    }
    const w = maxX - minX;
    const h = maxY - minY;
    // Degenerate box (all coincident, a line, or non-finite extent): brute force.
    if (!(w > 0) && !(h > 0)) {
      this.brute = true;
      return;
    }
    const area = Math.max(w, Number.EPSILON) * Math.max(h, Number.EPSILON);
    let cell = Math.sqrt(area / this.n);
    if (!(cell > 0) || !Number.isFinite(cell)) {
      this.brute = true;
      return;
    }
    // Clamp the cell count so a huge sparse AABB can't blow memory; grow the cell
    // size until cols*rows fits under MAX_CELLS.
    let cols = Math.max(1, Math.ceil(w / cell) + 1);
    let rows = Math.max(1, Math.ceil(h / cell) + 1);
    while (cols * rows > MAX_CELLS) {
      cell *= 2;
      cols = Math.max(1, Math.ceil(w / cell) + 1);
      rows = Math.max(1, Math.ceil(h / cell) + 1);
    }
    this.brute = false;
    this.minX = minX;
    this.minY = minY;
    this.cell = cell;
    this.cols = cols;
    this.rows = rows;
    this.cells = Array.from({ length: cols * rows }, () => []);
    for (let i = 0; i < this.n; i++) {
      this.cells[this.cellIndex(this.xs[i], this.ys[i])].push(i);
    }
  }

  private colOf(x: number): number {
    const c = Math.floor((x - this.minX) / this.cell);
    return c < 0 ? 0 : c >= this.cols ? this.cols - 1 : c;
  }

  private rowOf(y: number): number {
    const r = Math.floor((y - this.minY) / this.cell);
    return r < 0 ? 0 : r >= this.rows ? this.rows - 1 : r;
  }

  private cellIndex(x: number, y: number): number {
    return this.rowOf(y) * this.cols + this.colOf(x);
  }

  /**
   * Indices of all markers that *might* be within `radius` of `(x, y)` — a
   * superset of the true hits (never an under-count). Scans every cell the
   * `radius` box touches. With a degenerate/small index it scans all markers.
   */
  query(x: number, y: number, radius: number): number[] {
    if (this.brute || !Number.isFinite(radius)) {
      const all: number[] = [];
      for (let i = 0; i < this.n; i++) all.push(i);
      return all;
    }
    const r = Math.max(0, radius);
    const c0 = this.colOf(x - r);
    const c1 = this.colOf(x + r);
    const r0 = this.rowOf(y - r);
    const r1 = this.rowOf(y + r);
    const out: number[] = [];
    for (let row = r0; row <= r1; row++) {
      const rowBase = row * this.cols;
      for (let col = c0; col <= c1; col++) {
        const bucket = this.cells[rowBase + col];
        for (let k = 0; k < bucket.length; k++) out.push(bucket[k]);
      }
    }
    return out;
  }
}
