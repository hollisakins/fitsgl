import { describe, it, expect } from 'vitest';
import { TileManager, type LevelGeom } from '../src/renderer/tile-manager.js';
import type { TilePyramid } from '../src/fpack/tile-source.js';

/**
 * Minimal stub WebGL2 context: just the handful of calls `createTileTexture` and
 * `TileManager` make, with create/delete counters. No real GL — this exercises
 * the deferred-upload queue + eviction bookkeeping (P4), which the demo otherwise
 * verifies visually.
 */
function fakeGl(): { gl: WebGL2RenderingContext; created: () => number; deleted: () => number } {
  let created = 0;
  let deleted = 0;
  const obj: Record<string, unknown> = {};
  for (const [i, name] of [
    'TEXTURE_2D', 'R32F', 'RED', 'FLOAT', 'NEAREST', 'CLAMP_TO_EDGE',
    'TEXTURE_MIN_FILTER', 'TEXTURE_MAG_FILTER', 'TEXTURE_WRAP_S', 'TEXTURE_WRAP_T',
  ].entries()) {
    obj[name] = i + 1;
  }
  obj.createTexture = (): WebGLTexture => {
    created++;
    return {} as WebGLTexture;
  };
  obj.bindTexture = (): void => {};
  obj.texImage2D = (): void => {};
  obj.texParameteri = (): void => {};
  obj.deleteTexture = (): void => {
    deleted++;
  };
  return { gl: obj as unknown as WebGL2RenderingContext, created: () => created, deleted: () => deleted };
}

// 8×8 grid of full 256² tiles (2048² level), so every requested tile is 256×256.
const GEOM: LevelGeom = { z: 0, levelW: 2048, levelH: 2048, nTilesX: 8, nTilesY: 8 };
const GEOMS = new Map<number, LevelGeom>([[0, GEOM]]);
const TILE_LEN = 256 * 256;

/** Fake pyramid whose getTile resolves to a correctly-sized tile. */
function fakePyramid(): TilePyramid {
  return {
    getTile: () => Promise.resolve(new Float32Array(TILE_LEN)),
    hasTile: () => true,
  } as unknown as TilePyramid;
}

/** Let queued promise callbacks (request().then -> pendingUploads) settle. */
function settle(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe('TileManager upload queue (P4 throttling)', () => {
  it('defers the GPU upload until flushUploads, holding the tile inflight meanwhile', async () => {
    const { gl, created } = fakeGl();
    let loaded = 0;
    const mgr = new TileManager(gl, fakePyramid(), GEOMS, 200, () => {
      loaded++;
    });
    mgr.frame = 1;

    mgr.request(0, 0, 0);
    // A duplicate request while in flight must be a no-op (deduped via inflight).
    mgr.request(0, 0, 0);
    await settle();

    // Decoded + queued, but not yet uploaded: not resident, no texture created.
    expect(mgr.has(0, 0, 0)).toBe(false);
    expect(mgr.residentCount).toBe(0);
    expect(created()).toBe(0);
    expect(loaded).toBe(1); // onTileLoaded fired once (so the viewer schedules a frame)

    const remaining = mgr.flushUploads(8);
    expect(remaining).toBe(0);
    expect(mgr.has(0, 0, 0)).toBe(true);
    expect(mgr.residentCount).toBe(1);
    expect(created()).toBe(1);
    mgr.destroy();
  });

  it('uploads at most `budget` tiles per flush and reports the remainder', async () => {
    const { gl, created } = fakeGl();
    const mgr = new TileManager(gl, fakePyramid(), GEOMS, 200, () => {});
    mgr.frame = 1;

    for (let x = 0; x < 5; x++) mgr.request(0, x, 0);
    await settle();
    expect(mgr.residentCount).toBe(0);

    expect(mgr.flushUploads(2)).toBe(3);
    expect(mgr.residentCount).toBe(2);
    expect(mgr.flushUploads(2)).toBe(1);
    expect(mgr.residentCount).toBe(4);
    expect(mgr.flushUploads(2)).toBe(0);
    expect(mgr.residentCount).toBe(5);
    expect(created()).toBe(5);
    mgr.destroy();
  });

  it('does not re-request a tile that is queued for upload', async () => {
    let calls = 0;
    const pyramid = {
      getTile: () => {
        calls++;
        return Promise.resolve(new Float32Array(TILE_LEN));
      },
      hasTile: () => true,
    } as unknown as TilePyramid;
    const { gl } = fakeGl();
    const mgr = new TileManager(gl, pyramid, GEOMS, 200, () => {});
    mgr.frame = 1;

    mgr.request(0, 1, 1);
    await settle();
    mgr.request(0, 1, 1); // still queued (inflight) -> must not fetch again
    await settle();
    expect(calls).toBe(1);

    mgr.flushUploads(8);
    mgr.request(0, 1, 1); // now resident -> still no fetch
    expect(calls).toBe(1);
    mgr.destroy();
  });

  it('destroy() drops the queue without uploading', async () => {
    const { gl, created } = fakeGl();
    const mgr = new TileManager(gl, fakePyramid(), GEOMS, 200, () => {});
    mgr.frame = 1;
    mgr.request(0, 0, 0);
    await settle();
    mgr.destroy();
    expect(mgr.flushUploads(8)).toBe(0);
    expect(created()).toBe(0);
  });

  it('does not fetch a tile no supertile covers (gap in a partly-covered grid)', async () => {
    let calls = 0;
    // hasTile is false only for the gap tile (0,1); every other tile is covered.
    const pyramid = {
      getTile: () => {
        calls++;
        return Promise.resolve(new Float32Array(TILE_LEN));
      },
      hasTile: (_l: number, x: number, y: number) => !(x === 0 && y === 1),
    } as unknown as TilePyramid;
    const { gl } = fakeGl();
    const mgr = new TileManager(gl, pyramid, GEOMS, 200, () => {});
    mgr.frame = 1;

    mgr.request(0, 0, 1); // the gap → must NOT fetch (no doomed request / per-frame storm)
    await settle();
    expect(calls).toBe(0);
    expect(mgr.acquire(0, 0, 1)).toBeUndefined();

    mgr.request(0, 1, 1); // a covered tile → fetches normally
    await settle();
    expect(calls).toBe(1);
    mgr.destroy();
  });
});

describe('TileManager.warmLevel (speculative index prefetch)', () => {
  it('warms once per tile key and skips already-warmed / resident tiles', async () => {
    let warms = 0;
    const pyramid = {
      getTile: () => Promise.resolve(new Float32Array(TILE_LEN)),
      prefetchTileIndex: () => {
        warms++;
        return Promise.resolve();
      },
      hasTile: () => true,
    } as unknown as TilePyramid;
    const { gl } = fakeGl();
    const mgr = new TileManager(gl, pyramid, GEOMS, 200, () => {});
    mgr.frame = 1;

    mgr.warmLevel(0, 1, 1);
    mgr.warmLevel(0, 1, 1); // deduped via the warmed set
    expect(warms).toBe(1);

    mgr.warmLevel(0, 2, 2); // a distinct supertile → a second warm
    expect(warms).toBe(2);

    // A tile already resident needs no index warm.
    mgr.request(0, 3, 3);
    await settle();
    mgr.flushUploads(8);
    mgr.warmLevel(0, 3, 3);
    expect(warms).toBe(2);
    mgr.destroy();
  });
});

describe('TileManager request cancellation (P6a)', () => {
  /** Fake pyramid whose getTile hangs until its signal aborts, then rejects. */
  function hangingPyramid(): { pyramid: TilePyramid; calls: () => number } {
    let calls = 0;
    const pyramid = {
      getTile: (_l: number, _x: number, _y: number, signal?: AbortSignal) => {
        calls++;
        return new Promise<Float32Array>((_resolve, reject) => {
          if (signal?.aborted) {
            reject(signal.reason);
            return;
          }
          signal?.addEventListener('abort', () => reject(signal.reason));
          // otherwise never resolves
        });
      },
      hasTile: () => true,
    } as unknown as TilePyramid;
    return { pyramid, calls: () => calls };
  }

  // A 6-level pyramid (z=0 native … z=5 coarsest) for cross-level cancellation.
  const MULTI_GEOMS = new Map<number, LevelGeom>(
    Array.from({ length: 6 }, (_, z) => {
      const size = 8192 >> z;
      const n = Math.max(1, Math.ceil(size / 256));
      return [z, { z, levelW: size, levelH: size, nTilesX: n, nTilesY: n }] as const;
    }),
  );

  it('cancelExcept aborts an in-flight fetch outside the retain set; nothing uploads and it can be re-requested', async () => {
    const { pyramid, calls } = hangingPyramid();
    const { gl, created } = fakeGl();
    const mgr = new TileManager(gl, pyramid, GEOMS, 200, () => {});
    mgr.frame = 1;

    mgr.request(0, 2, 2);
    mgr.cancelExcept(0, new Set<string>(), [0]); // (2,2) not retained -> abort
    await settle();

    expect(mgr.residentCount).toBe(0);
    expect(created()).toBe(0);
    expect(mgr.flushUploads(8)).toBe(0); // never queued
    expect(calls()).toBe(1);

    // The abort cleared fetches/inflight, so a re-request fetches again.
    mgr.request(0, 2, 2);
    await settle();
    expect(calls()).toBe(2);
    mgr.destroy();
  });

  it('cancelExcept keeps a retained tile and every fetch at a kept level', async () => {
    const { pyramid, calls } = hangingPyramid();
    const { gl } = fakeGl();
    const mgr = new TileManager(gl, pyramid, MULTI_GEOMS, 200, () => {});
    mgr.frame = 1;

    mgr.request(0, 2, 2); // displayed level, retained
    mgr.request(1, 1, 1); // parent prefetch — kept unfiltered
    mgr.request(5, 0, 0); // pinned floor — kept unfiltered
    mgr.cancelExcept(0, new Set(['0/2/2']), [0, 1, 5]);
    await settle();
    // All three still in flight: re-requests are no-ops (no extra fetches).
    mgr.request(0, 2, 2);
    mgr.request(1, 1, 1);
    mgr.request(5, 0, 0);
    await settle();
    expect(calls()).toBe(3);
    mgr.destroy();
  });

  it('cancelExcept aborts leftover fetches at levels a multi-level zoom crossed (P6b)', async () => {
    const { pyramid, calls } = hangingPyramid();
    const { gl } = fakeGl();
    const mgr = new TileManager(gl, pyramid, MULTI_GEOMS, 200, () => {});
    mgr.frame = 1;

    // A fast zoom-in 4 -> 0 issued visible-tile fetches at every level crossed.
    for (let z = 4; z >= 0; z--) mgr.request(z, 0, 0);
    expect(calls()).toBe(5);

    // Arrived at level 0: keep the displayed level, its parent, and the floor.
    mgr.cancelExcept(0, new Set(['0/0/0']), [0, 1, 5]);
    await settle();

    // Levels 2-4 were aborted (re-requests fetch anew); 0 and 1 survived
    // (re-requests are deduped no-ops).
    mgr.request(0, 0, 0);
    mgr.request(1, 0, 0);
    expect(calls()).toBe(5);
    mgr.request(2, 0, 0);
    mgr.request(3, 0, 0);
    mgr.request(4, 0, 0);
    expect(calls()).toBe(8);
    mgr.destroy();
  });
});
