import { describe, it, expect } from 'vitest';
import type { Manifest } from '../src/manifest.js';
import {
  targetLevel,
  visibleTiles,
  ringTiles,
  centerOutOrder,
  allLevelTiles,
  coarserFallback,
  commonResidentLevel,
  finerFallback,
  resolveDisplayLevel,
  selectEvictions,
  buildLevelGeoms,
  tileWorldRect,
  tilePixelDims,
  worldPixelToTileIndex,
  fallbackUV,
  tileKey,
  type LevelGeom,
} from '../src/renderer/tile-manager.js';

/** A LevelGeom with sensible defaults for terse test construction. */
function geom(partial: Partial<LevelGeom> & { z: number }): LevelGeom {
  const levelW = partial.levelW ?? 512;
  const levelH = partial.levelH ?? 512;
  return {
    z: partial.z,
    levelW,
    levelH,
    nTilesX: partial.nTilesX ?? Math.ceil(levelW / 256),
    nTilesY: partial.nTilesY ?? Math.ceil(levelH / 256),
  };
}

describe('worldPixelToTileIndex (cursor value sampling — inverse of tileWorldRect)', () => {
  it('maps a z=0 point to its tile + row-major index', () => {
    const g = geom({ z: 0 }); // 512×512, four 256² tiles
    expect(worldPixelToTileIndex(g, 0.5, 0.5)).toEqual({ tileX: 0, tileY: 0, col: 0, row: 0, index: 0 });
    // (300, 5) → tile (1,0), in-tile (44, 5); full-width tile so stride 256.
    expect(worldPixelToTileIndex(g, 300, 5)).toEqual({ tileX: 1, tileY: 0, col: 44, row: 5, index: 5 * 256 + 44 });
  });

  it('uses the partial edge-tile width as the row stride', () => {
    const g = geom({ z: 0, levelW: 300, levelH: 300 }); // tile (1,0) is only 44 px wide
    // (280, 10) → tile (1,0), col 24, row 10; stride is 44, NOT 256.
    expect(worldPixelToTileIndex(g, 280, 10)).toEqual({ tileX: 1, tileY: 0, col: 24, row: 10, index: 10 * 44 + 24 });
  });

  it('applies the 2^z scale: a coarser level maps world px through f', () => {
    const g = geom({ z: 1, levelW: 256, levelH: 256 }); // f = 2
    // world (4, 4) → level px (2, 2) → tile (0,0) index 2*256+2.
    expect(worldPixelToTileIndex(g, 4, 4)).toEqual({ tileX: 0, tileY: 0, col: 2, row: 2, index: 2 * 256 + 2 });
    // world (510, 2) → level px (255, 1) → still tile (0,0), col 255.
    expect(worldPixelToTileIndex(g, 510, 2)).toEqual({ tileX: 0, tileY: 0, col: 255, row: 1, index: 1 * 256 + 255 });
  });

  it('returns null for a point outside the level grid', () => {
    const g = geom({ z: 0 }); // 512×512
    expect(worldPixelToTileIndex(g, -1, 5)).toBeNull();
    expect(worldPixelToTileIndex(g, 512, 5)).toBeNull(); // lx === levelW is out
    expect(worldPixelToTileIndex(g, 5, 600)).toBeNull();
  });

  it('round-trips against tileWorldRect: a tile origin maps back to that tile, col/row 0', () => {
    const g = geom({ z: 2, levelW: 400, levelH: 400 }); // f = 4
    for (const [tx, ty] of [[0, 0], [1, 0], [1, 1]] as const) {
      const rect = tileWorldRect(g, tx, ty);
      const loc = worldPixelToTileIndex(g, rect.x0 + 0.5, rect.y0 + 0.5);
      expect(loc).not.toBeNull();
      expect(loc!.tileX).toBe(tx);
      expect(loc!.tileY).toBe(ty);
      expect(loc!.col).toBe(0);
      expect(loc!.row).toBe(0);
    }
  });
});

describe('targetLevel', () => {
  it('picks the level whose tile pixel ~ one screen pixel (2^z ~ 1/zoom)', () => {
    const maxLevel = 4;
    expect(targetLevel(1, maxLevel)).toBe(0); // native
    expect(targetLevel(2, maxLevel)).toBe(0); // zoomed in -> still finest
    expect(targetLevel(0.5, maxLevel)).toBe(1);
    expect(targetLevel(0.25, maxLevel)).toBe(2);
    expect(targetLevel(0.4, maxLevel)).toBe(1); // round(1.32) = 1
    expect(targetLevel(0.1, maxLevel)).toBe(3); // round(3.32) = 3
  });

  it('clamps to [0, maxLevel]', () => {
    expect(targetLevel(10, 4)).toBe(0);
    expect(targetLevel(0.001, 4)).toBe(4);
    expect(targetLevel(0, 4)).toBe(4);
  });
});

describe('resolveDisplayLevel (defer level switch until settle)', () => {
  it('holds the previous level while the camera moves (deferral on)', () => {
    // Mid zoom-out: live wants a coarser level (2), but the gesture is active and
    // level 0 was showing -> keep 0 so the resident textures just resample.
    expect(resolveDisplayLevel(2, 0, false, true, 4)).toEqual({ level: 0, held: 0 });
    // Mid zoom-in: live wants finer (0), held coarse 2 -> keep 2 (blocky upscale).
    expect(resolveDisplayLevel(0, 2, false, true, 4)).toEqual({ level: 2, held: 2 });
  });

  it('adopts the live level once the camera settles', () => {
    expect(resolveDisplayLevel(2, 0, true, true, 4)).toEqual({ level: 2, held: 2 });
  });

  it('adopts the live level on the first frame (nothing held yet)', () => {
    expect(resolveDisplayLevel(3, null, false, true, 4)).toEqual({ level: 3, held: 3 });
  });

  it('switches live every frame when deferral is disabled', () => {
    expect(resolveDisplayLevel(2, 0, false, false, 4)).toEqual({ level: 2, held: 2 });
  });

  it('clamps a stale held level to [0, maxLevel] (e.g. after pyramid depth changed)', () => {
    expect(resolveDisplayLevel(0, 9, false, true, 4)).toEqual({ level: 4, held: 4 });
    expect(resolveDisplayLevel(0, -3, false, true, 4)).toEqual({ level: 0, held: 0 });
  });
});

describe('visibleTiles', () => {
  const g = geom({ z: 0, levelW: 512, levelH: 512 }); // 2x2 tiles, span 256

  it('returns all tiles when the viewport covers the whole image', () => {
    const tiles = visibleTiles(g, { x0: 0, y0: 0, x1: 512, y1: 512 });
    expect(tiles.map((t) => `${t.tileX},${t.tileY}`)).toEqual(['0,0', '1,0', '0,1', '1,1']);
  });

  it('returns a single tile for a sub-tile viewport', () => {
    const tiles = visibleTiles(g, { x0: 10, y0: 10, x1: 200, y1: 200 });
    expect(tiles).toEqual([{ level: 0, tileX: 0, tileY: 0 }]);
  });

  it('does not pull in the next tile when the viewport ends on a boundary', () => {
    const tiles = visibleTiles(g, { x0: 0, y0: 0, x1: 256, y1: 256 });
    expect(tiles).toEqual([{ level: 0, tileX: 0, tileY: 0 }]);
  });

  it('selects the far tile for a high-index viewport', () => {
    const tiles = visibleTiles(g, { x0: 300, y0: 300, x1: 500, y1: 500 });
    expect(tiles).toEqual([{ level: 0, tileX: 1, tileY: 1 }]);
  });

  it('clips a viewport that extends past the image to in-range tiles', () => {
    const tiles = visibleTiles(g, { x0: -100, y0: -100, x1: 100, y1: 100 });
    expect(tiles).toEqual([{ level: 0, tileX: 0, tileY: 0 }]);
  });

  it('returns nothing when the viewport does not overlap the imaged area', () => {
    expect(visibleTiles(g, { x0: 600, y0: 600, x1: 800, y1: 800 })).toEqual([]);
  });

  it('works at a coarse level where one tile spans many world pixels', () => {
    const g2 = geom({ z: 2, levelW: 128, levelH: 128, nTilesX: 1, nTilesY: 1 });
    // span = 256 * 4 = 1024 world px; the single tile covers [0,512) (128*4).
    const tiles = visibleTiles(g2, { x0: 0, y0: 0, x1: 512, y1: 512 });
    expect(tiles).toEqual([{ level: 2, tileX: 0, tileY: 0 }]);
  });

  // A level whose pixel dims are not a multiple of 256: tile (1,1) is a partial
  // edge tile covering world [256,300), so the imaged area stops at 300 even
  // though a full second tile column would reach 512. This exercises the
  // worldW/worldH clamp (which is a no-op on clean 2x2 levels).
  const gPartial = geom({ z: 0, levelW: 300, levelH: 300, nTilesX: 2, nTilesY: 2 });

  it('still selects a partial high-index edge tile that the viewport overlaps', () => {
    const tiles = visibleTiles(gPartial, { x0: 260, y0: 260, x1: 280, y1: 280 });
    expect(tiles).toEqual([{ level: 0, tileX: 1, tileY: 1 }]);
  });

  it('returns nothing for a viewport past the imaged area of a partial level', () => {
    // [305,320] is beyond the 300-px imaged width; a regression clamping to
    // nTilesX*span (=512) instead of worldW (=300) would wrongly return tile 1.
    expect(visibleTiles(gPartial, { x0: 305, y0: 305, x1: 320, y1: 320 })).toEqual([]);
  });
});

describe('ringTiles (prefetch margin)', () => {
  const g = geom({ z: 0, levelW: 2048, levelH: 2048 }); // 8x8 tiles, span 256

  const keys = (ts: ReturnType<typeof ringTiles>): Set<string> =>
    new Set(ts.map((t) => `${t.tileX},${t.tileY}`));

  it('returns the 1-tile band around the viewport, excluding visible tiles', () => {
    // Viewport over tiles (2,2)-(3,3); margin 1 -> box (1..4)x(1..4) minus (2..3)².
    const ring = ringTiles(g, { x0: 512, y0: 512, x1: 1024, y1: 1024 }, 1);
    expect(ring.length).toBe(4 * 4 - 2 * 2); // 16 expanded - 4 visible = 12
    const k = keys(ring);
    expect(k.has('2,2')).toBe(false); // visible excluded
    expect(k.has('1,1')).toBe(true); // corner of the ring
    expect(k.has('4,4')).toBe(true);
    for (const t of ring) {
      expect(t.tileX).toBeGreaterThanOrEqual(1);
      expect(t.tileX).toBeLessThanOrEqual(4);
    }
  });

  it('clamps the ring at the image edge', () => {
    // Viewport over tiles (0,0)-(1,1); margin 1 clamps low at 0 -> (0..2)² minus (0..1)².
    const ring = ringTiles(g, { x0: 0, y0: 0, x1: 512, y1: 512 }, 1);
    expect(ring.length).toBe(3 * 3 - 2 * 2); // 9 - 4 = 5
    expect(keys(ring).has('0,0')).toBe(false);
    expect(keys(ring).has('2,2')).toBe(true);
  });

  it('returns [] for margin 0 or a non-overlapping viewport', () => {
    expect(ringTiles(g, { x0: 0, y0: 0, x1: 512, y1: 512 }, 0)).toEqual([]);
    expect(ringTiles(g, { x0: 5000, y0: 5000, x1: 6000, y1: 6000 }, 1)).toEqual([]);
  });
});

describe('centerOutOrder', () => {
  const g = geom({ z: 0, levelW: 2048, levelH: 2048 }); // 8x8 tiles, span 256

  it('orders tiles by distance of their centre to the focus point (nearest first)', () => {
    // A 3x3 block of tiles (0..2)²; focus on the centre of tile (1,1) -> centre is
    // first, the four edge-adjacent tiles next, the four corners last.
    const tiles = [];
    for (let ty = 0; ty < 3; ty++) for (let tx = 0; tx < 3; tx++) tiles.push({ level: 0, tileX: tx, tileY: ty });
    const cx = 256 * 1 + 128; // centre of tile (1,1)
    const cy = 256 * 1 + 128;
    const ordered = centerOutOrder(tiles, g, cx, cy);
    expect({ x: ordered[0].tileX, y: ordered[0].tileY }).toEqual({ x: 1, y: 1 }); // nearest
    // The four corners (distance √2·span) are the last four, in some order.
    const lastFour = new Set(ordered.slice(5).map((t) => `${t.tileX},${t.tileY}`));
    expect(lastFour).toEqual(new Set(['0,0', '2,0', '0,2', '2,2']));
  });

  it('does not mutate the input and is a no-op shape for a single tile', () => {
    const input = [{ level: 0, tileX: 3, tileY: 4 }];
    const ordered = centerOutOrder(input, g, 0, 0);
    expect(ordered).toEqual(input);
    expect(ordered).not.toBe(input); // returns a fresh array
  });
});

describe('allLevelTiles (pinned fit-level floor grid)', () => {
  it('enumerates every tile of the level, row-major, tagged with the level z', () => {
    const g = geom({ z: 3, nTilesX: 3, nTilesY: 2 });
    const tiles = allLevelTiles(g);
    expect(tiles.length).toBe(3 * 2); // full grid, no gaps
    expect(tiles.every((t) => t.level === 3)).toBe(true);
    // Row-major: y outer, x inner.
    expect(tiles.map((t) => `${t.tileX},${t.tileY}`)).toEqual([
      '0,0', '1,0', '2,0', '0,1', '1,1', '2,1',
    ]);
    // Exactly the coordinate set covering the whole level (no dupes/omissions).
    const keys = new Set(tiles.map((t) => `${t.tileX},${t.tileY}`));
    expect(keys.size).toBe(6);
  });

  it('returns a single tile for a level that fits in one tile (the legacy floor)', () => {
    const tiles = allLevelTiles(geom({ z: 5, nTilesX: 1, nTilesY: 1 }));
    expect(tiles).toEqual([{ level: 5, tileX: 0, tileY: 0 }]);
  });
});

describe('tile <-> world geometry', () => {
  it('computes full-tile world rects at native resolution', () => {
    const g = geom({ z: 0, levelW: 512, levelH: 512 });
    expect(tileWorldRect(g, 0, 0)).toEqual({ x0: 0, y0: 0, x1: 256, y1: 256 });
    expect(tileWorldRect(g, 1, 1)).toEqual({ x0: 256, y0: 256, x1: 512, y1: 512 });
  });

  it('shrinks partial high-index edge tiles', () => {
    const g = geom({ z: 0, levelW: 300, levelH: 300, nTilesX: 2, nTilesY: 2 });
    expect(tilePixelDims(g, 1, 1)).toEqual({ width: 44, height: 44 });
    expect(tileWorldRect(g, 1, 1)).toEqual({ x0: 256, y0: 256, x1: 300, y1: 300 });
  });

  it('a coarse level still spans the full native width', () => {
    // 300px native -> z=1 image is 150px; one tile, covering world [0,300).
    const g = geom({ z: 1, levelW: 150, levelH: 150, nTilesX: 1, nTilesY: 1 });
    expect(tileWorldRect(g, 0, 0)).toEqual({ x0: 0, y0: 0, x1: 300, y1: 300 });
  });

  it('fallbackUV maps a fine tile into its ancestor texture sub-rect', () => {
    const fine = { x0: 256, y0: 0, x1: 512, y1: 256 }; // z=0 tile (1,0)
    const coarse = { x0: 0, y0: 0, x1: 512, y1: 512 }; // z=1 tile (0,0) covering it
    expect(fallbackUV(fine, coarse)).toEqual([0.5, 0, 1, 0.5]);
  });

  it('fallbackUV subtracts the ancestor origin (non-origin ancestor)', () => {
    // Ancestor not at (0,0): a regression dropping the `- ancestor.x0` term would
    // give garbage (e.g. 300/256 ≈ 1.17) instead of these offsets.
    const fine = { x0: 300, y0: 300, x1: 400, y1: 400 };
    const ancestor = { x0: 256, y0: 256, x1: 512, y1: 512 };
    expect(fallbackUV(fine, ancestor)).toEqual([0.171875, 0.171875, 0.5625, 0.5625]);
  });

  it('fallbackUV clamps to [0,1] when a fine edge tile overruns its ancestor', () => {
    // Trimmed pyramid: fine level reaches world 1500, ancestor only 1496.
    const fine = { x0: 1024, y0: 1024, x1: 1500, y1: 1500 };
    const ancestor = { x0: 0, y0: 0, x1: 1496, y1: 1496 };
    const [u0, v0, u1, v1] = fallbackUV(fine, ancestor);
    expect(u1).toBe(1);
    expect(v1).toBe(1);
    expect(u0).toBeCloseTo(1024 / 1496, 9);
    expect(v0).toBeCloseTo(1024 / 1496, 9);
  });
});

describe('coarserFallback', () => {
  const maxLevel = 4;

  it('returns the finest loaded ancestor', () => {
    const loaded = new Set([tileKey(1, 2, 1), tileKey(2, 1, 0)]);
    const fb = coarserFallback(0, 5, 3, maxLevel, (l, x, y) => loaded.has(tileKey(l, x, y)));
    // level 1 ancestor of (0,5,3) is (1, 2, 1) -> loaded, and it is the finest.
    expect(fb).toEqual({ level: 1, tileX: 2, tileY: 1 });
  });

  it('skips unloaded ancestors and returns a coarser one', () => {
    const loaded = new Set([tileKey(2, 1, 0)]);
    const fb = coarserFallback(0, 5, 3, maxLevel, (l, x, y) => loaded.has(tileKey(l, x, y)));
    expect(fb).toEqual({ level: 2, tileX: 1, tileY: 0 });
  });

  it('returns null when no ancestor is loaded', () => {
    const fb = coarserFallback(0, 5, 3, maxLevel, () => false);
    expect(fb).toBeNull();
  });

  it('returns null at the coarsest level (no ancestors exist)', () => {
    const fb = coarserFallback(maxLevel, 0, 0, maxLevel, () => true);
    expect(fb).toBeNull();
  });
});

describe('finerFallback (zoom-out, overlays resident finer detail)', () => {
  it('returns all four descendants when the nearest finer block is fully resident', () => {
    // Target (1,2,1); its four z=0 descendants are (4,2),(5,2),(4,3),(5,3).
    const loaded = new Set([
      tileKey(0, 4, 2),
      tileKey(0, 5, 2),
      tileKey(0, 4, 3),
      tileKey(0, 5, 3),
    ]);
    const fb = finerFallback(1, 2, 1, (l, x, y) => loaded.has(tileKey(l, x, y)));
    expect(fb?.level).toBe(0);
    expect(fb?.tiles).toEqual([
      { level: 0, tileX: 4, tileY: 2 },
      { level: 0, tileX: 5, tileY: 2 },
      { level: 0, tileX: 4, tileY: 3 },
      { level: 0, tileX: 5, tileY: 3 },
    ]);
  });

  it('returns the PARTIAL resident subset (the key zoom-out / periphery case)', () => {
    // Only three of the four z=0 descendants of (1,2,1) are resident — the caller
    // draws a coarse base under these and overlays them where they exist.
    const loaded = new Set([tileKey(0, 4, 2), tileKey(0, 5, 2), tileKey(0, 4, 3)]);
    const fb = finerFallback(1, 2, 1, (l, x, y) => loaded.has(tileKey(l, x, y)));
    expect(fb?.level).toBe(0);
    expect(fb?.tiles).toEqual([
      { level: 0, tileX: 4, tileY: 2 },
      { level: 0, tileX: 5, tileY: 2 },
      { level: 0, tileX: 4, tileY: 3 },
    ]);
  });

  it('prefers the NEAREST finer level with any resident detail (fewest, sharpest)', () => {
    // Target (2,1,0). z=1 block {(2,0),(3,0),(2,1),(3,1)} is resident, and so is
    // z=0 — but z=1 is nearer the target, so it wins (4 tiles, not 16).
    const loaded = new Set<string>();
    for (let x = 2; x <= 3; x++) for (let y = 0; y <= 1; y++) loaded.add(tileKey(1, x, y));
    for (let x = 4; x <= 7; x++) for (let y = 0; y <= 3; y++) loaded.add(tileKey(0, x, y));
    const fb = finerFallback(2, 1, 0, (l, x, y) => loaded.has(tileKey(l, x, y)));
    expect(fb?.level).toBe(1);
    expect(fb?.tiles).toHaveLength(4);
  });

  it('falls through to a finer-still level when the nearer one has nothing resident', () => {
    // z=1 empty; the resident z=0 patch (a far-finer remnant, e.g. the native view
    // before a fast zoom-out) is surfaced instead of nothing.
    const loaded = new Set<string>();
    for (let x = 4; x <= 7; x++) for (let y = 0; y <= 3; y++) loaded.add(tileKey(0, x, y));
    const fb = finerFallback(2, 1, 0, (l, x, y) => loaded.has(tileKey(l, x, y)));
    expect(fb?.level).toBe(0);
    expect(fb?.tiles).toHaveLength(16);
  });

  it('returns null when nothing finer is resident', () => {
    expect(finerFallback(1, 2, 1, () => false)).toBeNull();
  });

  it('caps the walk at maxDepth levels below the target (per-frame cost bound)', () => {
    // Only z=0 detail is resident under target (3,0,0) — three levels down, past
    // the default depth cap of 2, so it is NOT surfaced (the coarse base covers).
    const loaded = new Set<string>();
    for (let x = 0; x <= 7; x++) for (let y = 0; y <= 7; y++) loaded.add(tileKey(0, x, y));
    const probe = (l: number, x: number, y: number): boolean => loaded.has(tileKey(l, x, y));
    expect(finerFallback(3, 0, 0, probe)).toBeNull();
    // An explicit deeper cap restores the exhaustive walk.
    const fb = finerFallback(3, 0, 0, probe, 3);
    expect(fb?.level).toBe(0);
    expect(fb?.tiles).toHaveLength(64);
  });

  it('never probes deeper than maxDepth (call-count bound)', () => {
    let calls = 0;
    const probe = (): boolean => {
      calls++;
      return false;
    };
    expect(finerFallback(6, 0, 0, probe)).toBeNull();
    expect(calls).toBe(4 + 16); // depth 1 + depth 2, nothing deeper
  });

  it('returns null at the finest level (z=0 has no descendants)', () => {
    expect(finerFallback(0, 5, 3, () => true)).toBeNull();
  });
});

describe('commonResidentLevel (RGB composite, M4)', () => {
  const maxLevel = 4;

  it('returns the TARGET level when all bands have the tile there (the inclusive-L case coarserFallback misses)', () => {
    const found = commonResidentLevel(0, 5, 3, maxLevel, (l, x, y) =>
      l === 0 && x === 5 && y === 3,
    );
    expect(found).toEqual({ level: 0, tileX: 5, tileY: 3 });
  });

  it('walks up to the finest level common to all bands when the target is not all-resident', () => {
    // Common only at level 1: ancestor of (0,5,3) at z=1 is (1,2,1).
    const found = commonResidentLevel(0, 5, 3, maxLevel, (l, x, y) =>
      l === 1 && x === 2 && y === 1,
    );
    expect(found).toEqual({ level: 1, tileX: 2, tileY: 1 });
  });

  it('finds the common level even when bands diverge at finer levels', () => {
    // R has (0,5,3)+(2,1,0); G has (1,2,1)+(2,1,0); B has (2,1,0). The only level
    // where ALL THREE share the ancestor is z=2 -> (2,1,0).
    const r = new Set([tileKey(0, 5, 3), tileKey(2, 1, 0)]);
    const g = new Set([tileKey(1, 2, 1), tileKey(2, 1, 0)]);
    const b = new Set([tileKey(2, 1, 0)]);
    const found = commonResidentLevel(0, 5, 3, maxLevel, (l, x, y) => {
      const k = tileKey(l, x, y);
      return r.has(k) && g.has(k) && b.has(k);
    });
    expect(found).toEqual({ level: 2, tileX: 1, tileY: 0 });
  });

  it('returns null when no level is common to all bands', () => {
    const r = new Set([tileKey(0, 5, 3)]);
    const g = new Set([tileKey(1, 2, 1)]);
    const found = commonResidentLevel(0, 5, 3, maxLevel, (l, x, y) => {
      const k = tileKey(l, x, y);
      return r.has(k) && g.has(k); // B has nothing
    });
    expect(found).toBeNull();
  });

  it('probes the target level first (inclusive), then walks ancestors, stopping at the common level', () => {
    // The viewer passes a predicate that acquire()s every band at each consulted
    // level; this records that the helper consults L, then its ancestors, and
    // stops — the hook that keeps a band-ahead tile from being evicted while a
    // laggard sibling loads.
    const calls: Array<[number, number, number]> = [];
    const resident = new Set([tileKey(2, 1, 0)]);
    const found = commonResidentLevel(0, 5, 3, maxLevel, (l, x, y) => {
      calls.push([l, x, y]);
      return resident.has(tileKey(l, x, y));
    });
    expect(found).toEqual({ level: 2, tileX: 1, tileY: 0 });
    expect(calls).toEqual([
      [0, 5, 3],
      [1, 2, 1],
      [2, 1, 0],
    ]);
  });

  it('fromLevel=level+1 skips the target level (crossfade-base case)', () => {
    // The target (0,5,3) IS resident in all bands, but with fromLevel=1 the search
    // starts strictly coarser and returns the z=1 ancestor instead of the tile.
    const resident = new Set([tileKey(0, 5, 3), tileKey(1, 2, 1)]);
    const found = commonResidentLevel(
      0,
      5,
      3,
      maxLevel,
      (l, x, y) => resident.has(tileKey(l, x, y)),
      1,
    );
    expect(found).toEqual({ level: 1, tileX: 2, tileY: 1 });
  });
});

describe('selectEvictions', () => {
  it('evicts tiles idle for more than maxIdle frames', () => {
    const entries = [
      { key: 'a', lastVisibleFrame: 100 },
      { key: 'b', lastVisibleFrame: 30 }, // 100 - 30 = 70 > 60
      { key: 'c', lastVisibleFrame: 45 }, // 100 - 45 = 55 <= 60
    ];
    expect(selectEvictions(entries, 1000, 100, 60).sort()).toEqual(['b']);
  });

  it('keeps a tile idle for exactly maxIdle frames, evicts at maxIdle+1', () => {
    // Strict `>`: diff == maxIdle survives, diff == maxIdle+1 is evicted. Guards
    // against a `>` -> `>=` off-by-one at the threshold.
    const entries = [
      { key: 'boundary', lastVisibleFrame: 40 }, // 100 - 40 = 60 == maxIdle -> keep
      { key: 'past', lastVisibleFrame: 39 }, // 100 - 39 = 61 > maxIdle -> evict
    ];
    expect(selectEvictions(entries, 1000, 100, 60)).toEqual(['past']);
  });

  it('evicts least-recently-visible survivors past the budget, oldest first', () => {
    // Keys ordered so recency (oldest first) is the REVERSE of alphabetical, so a
    // regression evicting by insertion/alphabetical order instead of recency is
    // caught: the two OLDEST (z@1, y@2) must be dropped, not a@9/b@8.
    const entries = [
      { key: 'a', lastVisibleFrame: 9 },
      { key: 'b', lastVisibleFrame: 8 },
      { key: 'y', lastVisibleFrame: 2 },
      { key: 'z', lastVisibleFrame: 1 },
    ];
    expect(selectEvictions(entries, 2, 10, 60).sort()).toEqual(['y', 'z']);
  });

  it('never budget-evicts tiles visible on the current frame (no thrash)', () => {
    // All four were drawn this frame (lastVisibleFrame === frame). Even though the
    // budget is 2, none may be evicted — dropping a just-drawn tile would force an
    // immediate re-upload next frame.
    const entries = [
      { key: 'a', lastVisibleFrame: 10 },
      { key: 'b', lastVisibleFrame: 10 },
      { key: 'c', lastVisibleFrame: 10 },
      { key: 'd', lastVisibleFrame: 10 },
    ];
    expect(selectEvictions(entries, 2, 10, 60)).toEqual([]);
  });

  it('budget-evicts only stale tiles, sparing this-frame ones even over budget', () => {
    const entries = [
      { key: 'cur1', lastVisibleFrame: 20 }, // current frame -> protected
      { key: 'cur2', lastVisibleFrame: 20 }, // current frame -> protected
      { key: 'old1', lastVisibleFrame: 5 }, // stale, oldest -> evicted first
      { key: 'old2', lastVisibleFrame: 6 }, // stale
    ];
    // budget 2, 4 resident -> drop 2 stale, oldest first.
    expect(selectEvictions(entries, 2, 20, 60).sort()).toEqual(['old1', 'old2']);
  });

  it('combines idle + budget eviction without double-counting', () => {
    const entries = [
      { key: 'old', lastVisibleFrame: 0 }, // idle: 200 - 0 > 60
      { key: 'p', lastVisibleFrame: 190 },
      { key: 'q', lastVisibleFrame: 191 },
      { key: 'r', lastVisibleFrame: 192 },
    ];
    // 'old' is idle-evicted; of the 3 survivors, budget 2 drops the oldest ('p').
    expect(selectEvictions(entries, 2, 200, 60).sort()).toEqual(['old', 'p']);
  });

  it('evicts nothing when under budget and all recently visible', () => {
    const entries = [
      { key: 'a', lastVisibleFrame: 10 },
      { key: 'b', lastVisibleFrame: 11 },
    ];
    expect(selectEvictions(entries, 200, 12, 60)).toEqual([]);
  });
});

describe('buildLevelGeoms', () => {
  it('derives per-level geometry from a manifest', () => {
    const manifest: Manifest = {
      version: 1,
      source_file: 'm.fits',
      native_shape: [512, 512],
      fpack_tile_size: 256,
      n_levels: 1,
      levels: [
        {
          z: 0,
          filename: 'm_z0.fits.fz',
          compression: 'GZIP_2',
          lossless: true,
          shape: [512, 512],
          fpack_tile_count: [2, 2],
          pixel_scale_arcsec: 0.03,
          wcs: {},
          supertiles: [{ filename: 'm_z0.fits.fz', tile_origin: [0, 0], tile_count: [2, 2] }],
        },
        {
          z: 1,
          filename: 'm_z1.fits.fz',
          compression: 'RICE_1',
          lossless: false,
          shape: [256, 256],
          fpack_tile_count: [1, 1],
          pixel_scale_arcsec: 0.06,
          wcs: {},
          supertiles: [{ filename: 'm_z1.fits.fz', tile_origin: [0, 0], tile_count: [1, 1] }],
        },
      ],
    };
    const geoms = buildLevelGeoms(manifest);
    expect(geoms.get(0)).toEqual({ z: 0, levelW: 512, levelH: 512, nTilesX: 2, nTilesY: 2 });
    expect(geoms.get(1)).toEqual({ z: 1, levelW: 256, levelH: 256, nTilesX: 1, nTilesY: 1 });
  });
});
