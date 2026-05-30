import { describe, it, expect } from 'vitest';
import {
  glyphContains,
  glyphHalfBuffer,
  broadPhaseWorldRadius,
  pickMarker,
  wasClick,
  HIT_SLOP_CSS,
} from '../src/overlay/hit-test.js';
import { worldToScreen, IDENTITY_MAT2, type Mat2, type ViewParams } from '../src/renderer/view-transform.js';
import { GridIndex } from '../src/overlay/spatial-index.js';
import type { ResolvedMarker } from '../src/overlay/markers.js';

function marker(id: string, x: number, y: number, over: Partial<ResolvedMarker> = {}): ResolvedMarker {
  return {
    id,
    x,
    y,
    ra: null,
    dec: null,
    shape: 'circle',
    size: 12,
    color: [1, 1, 1, 1],
    edgeWidth: 1.5,
    data: {},
    ...over,
  };
}

const view: ViewParams = { centerX: 100, centerY: 200, zoom: 0.5, viewportWidth: 800, viewportHeight: 600 };

describe('glyphContains', () => {
  it('disc test for point/circle, Chebyshev square for box', () => {
    expect(glyphContains('circle', 3, 4, 5)).toBe(true); // dist 5 == half
    expect(glyphContains('circle', 4, 4, 5)).toBe(false); // dist 5.66 > 5
    expect(glyphContains('point', 0, 5, 5)).toBe(true);
    // box: corner (5,5) is inside (Chebyshev 5 <= 5) where the disc would exclude it.
    expect(glyphContains('box', 5, 5, 5)).toBe(true);
    expect(glyphContains('box', 6, 0, 5)).toBe(false);
  });
});

describe('wasClick', () => {
  it('is a click when travel is under the CSS-px threshold (dpr-scaled)', () => {
    expect(wasClick(100, 100, 101, 101, 1)).toBe(true); // ~1.4 px < 3
    expect(wasClick(100, 100, 110, 100, 1)).toBe(false); // 10 px > 3
    // At dpr=2 the threshold is 6 buffer px, so a 5-buffer-px wobble is still a click.
    expect(wasClick(0, 0, 5, 0, 2)).toBe(true);
    expect(wasClick(0, 0, 5, 0, 1)).toBe(false);
  });
});

describe('broad/narrow phase agree (no false negatives) across dpr', () => {
  it('the broad-phase world radius is never smaller than the narrow glyph radius', () => {
    for (const dpr of [1, 2, 3]) {
      const half = glyphHalfBuffer(12, dpr);
      // maxSize >= the marker size, so the broad radius covers the narrow glyph.
      const r = broadPhaseWorldRadius(12, dpr, view.zoom);
      expect(r).toBeCloseTo(half / view.zoom, 9);
      expect(broadPhaseWorldRadius(20, dpr, view.zoom)).toBeGreaterThanOrEqual(r);
    }
  });

  it('a cursor the narrow phase accepts is returned by the grid broad phase (dpr 1..3)', () => {
    // Spaced far enough apart that the near-edge cursor on 'a' can only hit 'a'
    // even at dpr=3 (where the glyph half-extent is ~21 buffer px).
    const markers = [marker('a', 100, 200), marker('b', 400, 500), marker('c', -50, 600)];
    const grid = new GridIndex(markers);
    for (const dpr of [1, 2, 3]) {
      const m = markers[0];
      const s = worldToScreen(view, IDENTITY_MAT2, m.x, m.y);
      const half = glyphHalfBuffer(m.size, dpr);
      // Cursor just inside the glyph edge (buffer px).
      const cx = s.x + (half - 0.05);
      const cy = s.y;
      // narrow phase accepts:
      const picked = pickMarker([0, 1, 2], markers, view, IDENTITY_MAT2, cx, cy, dpr);
      expect(picked?.id).toBe('a');
      // broad phase (grid) returns it for the same radius:
      const worldCursor = { x: (cx - view.viewportWidth / 2) / view.zoom + view.centerX, y: (cy - view.viewportHeight / 2) / view.zoom + view.centerY };
      const radius = broadPhaseWorldRadius(12, dpr, view.zoom);
      expect(grid.query(worldCursor.x, worldCursor.y, radius)).toContain(0);
    }
  });
});

describe('pickMarker', () => {
  it('returns null when nothing is under the cursor', () => {
    const markers = [marker('a', 0, 0)];
    expect(pickMarker([0], markers, view, IDENTITY_MAT2, 0, 0, 1)).toBeNull();
  });

  it('returns the TOPMOST (highest index) marker among overlapping hits', () => {
    const markers = [marker('under', 100, 200), marker('over', 100, 200)];
    const s = worldToScreen(view, IDENTITY_MAT2, 100, 200);
    const picked = pickMarker([0, 1], markers, view, IDENTITY_MAT2, s.x, s.y, 1);
    expect(picked?.id).toBe('over');
    // Order of candidates must not matter.
    expect(pickMarker([1, 0], markers, view, IDENTITY_MAT2, s.x, s.y, 1)?.id).toBe('over');
  });

  it('is exact under a North-up flip orientation', () => {
    const flip: Mat2 = [1, 0, 0, -1];
    const m = marker('a', 137, 250, { size: 10 });
    const s = worldToScreen(view, flip, m.x, m.y);
    // On the marker centre: hit.
    expect(pickMarker([0], [m], view, flip, s.x, s.y, 1)?.id).toBe('a');
    // One pixel beyond the glyph radius: miss.
    const half = glyphHalfBuffer(10, 1);
    expect(pickMarker([0], [m], view, flip, s.x + half + 1.5, s.y, 1)).toBeNull();
  });

  it('uses the slop so a thin glyph stays comfortably clickable', () => {
    expect(HIT_SLOP_CSS).toBeGreaterThan(0);
    const m = marker('a', 100, 200, { size: 2 });
    const s = worldToScreen(view, IDENTITY_MAT2, 100, 200);
    // size 2 -> radius 1 css; with slop the half-extent is (1 + slop) buffer px.
    expect(pickMarker([0], [m], view, IDENTITY_MAT2, s.x + 1.5, s.y, 1)?.id).toBe('a');
  });
});
