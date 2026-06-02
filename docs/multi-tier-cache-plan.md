# Implementation plan — multi-tier tile cache + parallel decode

**Goal.** Add a persistent local cache of **compressed** tiles as a first-class
tier, so warm reloads/revisits are instant on *any* host (static university
cluster or cloud), with Cloudflare as an optional accelerator — and parallelize
decode so the disk tier's warm-reload path isn't bottlenecked on a single decode
thread.

**End-state cache hierarchy:**

```
draw → GPU textures (decoded R32F)          main thread, ~50 MB/band   [exists]
        ↑ miss
       RAM LRU (decoded Float32Array)        worker, ~64 MB/band        [exists]
        ↑ miss
       Disk (IndexedDB, COMPRESSED bytes)    worker, persistent, ~1 GB  [NEW]
        ↑ miss
       fetch → browser HTTP cache → [CF edge → CF origin]   all optional
```

One decode path, fed by `{disk | network}` (both deliver identical compressed
bytes); two decoded tiers (RAM, GPU) above it. Decode parallelized across a small
worker pool.

This plan supersedes the §1/§4/§5 recommendations in
`docs/client-performance-report.md` with a concrete, sequenced build.

---

## Key design decisions (these shape the code)

1. **Compressed on disk, decoded in RAM/GPU.** ~45 kB/tile (q8) vs 256 kB decoded
   → ~5× more tiles per GB. The disk tier substitutes for the *network fetch*, not
   the decode, so it slots in at the same seam and the bit-exact decode is
   untouched.

2. **Disk = IndexedDB behind an injectable `BlobStore` interface.** Mirrors the
   existing `RangeFetcher` / `WorkerLike` injection pattern: the production impl is
   IndexedDB-backed; tests inject an in-memory `Map`-backed impl, so the cache
   logic unit-tests in Node with **no new runtime or test dependency** (consistent
   with CLAUDE.md's "browser-native, no third-party libs"). IndexedDB runs in the
   worker (off the main thread).

3. **Pure logic split from I/O** (CLAUDE.md convention): key derivation, the
   disk-LRU eviction policy, and sizing math are pure functions tested in Node; the
   `IDBDatabase` binding is a thin adapter behind `BlobStore`.

4. **Key scheme:** `"${fingerprint}/${level}/${x}/${y}"` for tiles,
   `"${fingerprint}/meta/${level}"` for per-level metadata. `fingerprint` is a
   stable hash of the manifest JSON (Phase 2). A later `build_id` stamped by
   `pyramid_gen` makes it robust and does **double duty** as the Cloudflare
   `immutable` versioned-path segment (Phase 6). A changed pyramid → new
   fingerprint → old entries become unreachable and LRU-evict.

5. **Worker pool = N × `TileEngine`, routed by `hash(level,x,y) % N`** (recommended
   "Shape A" — lowest churn from today's single TileEngine-in-worker). Deterministic
   routing means each tile belongs to exactly one worker, so per-worker RAM LRUs
   partition cleanly (no duplication of a given tile) and in-flight dedup still
   works. IndexedDB is shared per-origin, so **disk is shared**; each worker manages
   a `budget/N` slice of the disk LRU over its own (disjoint) key partition — no
   cross-worker counter contention. `N = min(4, hardwareConcurrency − 1)`.
   *(Trade-off + the metadata-amplification wrinkle are in "Open decisions" below.)*

6. **RAM tier stays decoded.** A RAM hit avoids both a disk read and a decode (the
   bottleneck), so it's the fast path for "evicted from GPU, still in session."

---

## The code seam (confirmed)

`FpackFile.getTile` (`fpack-file.ts:254-298`) is a fetch-half + a pure decode-half.
Split it so the cache can sit between:

```ts
// fpack-file.ts — refactor, no behavior change
interface TileDecodeParams {            // everything decode needs, no file handle
  compressionType: CompressionType;
  nPixels: number; blockSize: number;
  zscale: number; zzero: number; zblank: number;
  ditherMethod: number; zdither0: number; tileIndex: number; // row
}
class FpackFile {
  async compressedTile(x, y): Promise<{ bytes: Uint8Array; params: TileDecodeParams }>  // index lookup + getBytes + assemble params
  static decodeTile(bytes, params): Float32Array   // = current decodeRice/Gzip2 dispatch (pure)
  getTile(x, y) { /* compose the two — keeps the existing public API */ }
}
```

`TileEngine.getTile` (`tile-source.ts:79-98`) — insert the disk tier inside the
existing `inflight`-wrapped IIFE so dedup atomically covers disk+network+decode:

```ts
const promise = (async () => {
  const file = await this.fileForLevel(level);          // open + index (Phase 3: from disk meta)
  const { bytes, params } = await file.compressedTile(tileX, tileY)  // ← becomes:
  //   diskKey = key(fingerprint, level, x, y)
  //   bytes = await this.blobStore.get(diskKey)
  //        ?? await file.fetchCompressedTile(x,y).then(b => { void this.blobStore.put(diskKey, b); return b })
  //   params = file.tileDecodeParams(x,y)               // from the (cached) index
  const tile = FpackFile.decodeTile(bytes, params);
  this.cache.set(key, tile);                            // RAM (decoded)
  return tile;
})();
```

---

## Phases (each independently shippable; later phases depend on earlier)

```
P0 prime ─┐
P1 split ─┼─→ P2 disk cache ─→ P4 pool+throttle ─→ P5 prefetch
          │        └─→ P3 level-meta (optional)
          └────────────────────────────────────→ P6 cancel + CF versioning (optional)
```

### P0 — Single-band coarse prime  *(quick win, fully independent)*
- **What:** when `mode==='single'`, also `request(maxLevel,0,0)` in the constructor
  and `setSource`, and re-`acquire` the coarsest tile each frame so it survives the
  60-idle eviction (mirror what RGB already does).
- **Why:** eliminates the black-screen-on-load and most fine-pan blanks; makes
  coarse-to-fine actually have something to show. Prerequisite for the disk cache to
  *feel* instant (a warm coarse tile paints immediately).
- **Touches:** `renderer/viewer.ts` (~377, ~601, draw loop); optional pin in
  `tile-manager.ts` `selectEvictions`.
- **Tests:** `tile-manager`/viewer: first single-band frame has the coarsest tile
  requested; coarse tile not evicted while in view.
- **Size:** ~10–20 lines. **Do this first regardless of the rest.**

### P1 — Refactor the fetch/decode seam  *(pure refactor, zero behavior change)*
- **What:** split `FpackFile.getTile` into `compressedTile()` / `tileDecodeParams()`
  / `fetchCompressedTile()` + static `decodeTile()`; keep `getTile` as the
  composition. Add `TileDecodeParams`.
- **Why:** creates the insertion point for the disk tier without touching decode
  math. **Bit-exact gate stays green** (same bytes → same floats).
- **Touches:** `fpack/fpack-file.ts` only.
- **Tests:** existing `fpack-file.test.ts` / `decode-*.test.ts` must pass unchanged;
  add a test that `decodeTile(compressedTile(x,y))` equals the old `getTile(x,y)`.

### P2 — Disk cache (compressed tiles)  *(the core new tier)*
- **What:**
  - `fpack/blob-store.ts`: `interface BlobStore { get(key); put(key, bytes); delete(key); }`
    + pure helpers `tileKey(fingerprint, level, x, y)` and an LRU policy
    `selectDiskEvictions(entries, budgetBytes)` (mirrors `selectEvictions`).
  - `fpack/idb-blob-store.ts`: IndexedDB-backed `BlobStore`. One object store
    `tiles` (key → `{bytes, byteLength, lastAccess, level}`). On open: `persist()`
    request + one cursor scan to build an in-memory `{key→{size,lastAccess}}` map and
    a running total; LRU-evict oldest over budget on write. **All wrapped in
    try/catch** → on failure (incognito/quota/disabled) return a null store so the
    tier no-ops and falls through to network.
  - `fpack/cache-size.ts`: `budgetBytes = min(targetCap≈1 GB, quota*fraction)` from
    `navigator.storage.estimate()`.
  - Wire into `TileEngine` (per design seam above); add `fingerprint` to
    `TileEngineOptions`/worker `init`; derive it from a manifest-content hash.
  - Partition budget per worker (`budgetBytes / N`) so the pool (P4) needs no shared
    counter.
- **Why:** warm reloads/revisits serve tiles from disk → 0 network. This is the
  tier that makes "warm survives reload" true on any host.
- **Touches:** new `fpack/blob-store.ts`, `fpack/idb-blob-store.ts`,
  `fpack/cache-size.ts`; `fpack/tile-source.ts` (`TileEngine`), `worker.ts`,
  `fpack/worker-protocol.ts` (`init` carries fingerprint + budget).
- **Tests:** in-memory `BlobStore`: cold get → put + decode; warm get → 0 fetch
  (assert via a counting `RangeFetcher`) → decode bit-identical; LRU eviction over
  budget; null-store degradation falls through to fetch. **Round-trip bit-exactness
  is the gate.**
- **Note:** at this phase, opening a level still costs the head+index fetch on
  reload (the metadata RTTs); tiles come from disk. P3 removes that.

### P3 — Level-meta caching  *(optional; full offline warm path)*
- **What:** cache `FpackFile.serializeMeta()` (scalars + parsed `TileIndexEntry[]`)
  under `meta/${level}` in a second object store; `FpackFile.fromCachedMeta(url,
  fetcher, meta)` reconstructs without the head+index fetch. `fileForLevel` checks
  disk meta first.
- **Why:** eliminates the 1–2 per-level metadata RTTs on warm reload → a previously
  viewed region reloads with **zero network**. Most valuable on static clusters /
  flaky networks.
- **Touches:** `fpack/fpack-file.ts` (serialize/reconstruct), `fpack/tile-source.ts`
  (`fileForLevel`), `idb-blob-store.ts` (meta store).
- **Tests:** reconstruct-from-meta produces a FpackFile that decodes identically;
  warm level open → 0 fetch.

### P4 — Worker pool + upload throttling  *(motivated by P2: disk shifts the bottleneck to decode)*
- **What:**
  - `TilePyramid` holds `workers: WorkerLike[]` (size N); route `getTile` to
    `workers[hash(level,x,y) % N]`; keep main-side `inflight` dedup. Extend
    `workerFactory` → `workerPoolFactory`.
  - **Upload throttling** in `TileManager`: queue resolved tiles; in `draw()` drain
    ≤ K uploads (or ≤ T ms) per frame, `requestRender()` again if the queue isn't
    empty. Coarse fallback keeps deferral invisible.
- **Why:** after P2, warm-from-disk reload = N disk reads + N **serial** decodes
  (~3 ms each → ~120 ms for 40 tiles on one worker) with no network to hide behind;
  a pool of 4 → ~30 ms. Throttling prevents the now-unstaggered `texImage2D` burst
  from blowing the 16 ms frame. (RGB already gets 3-way parallelism; this fixes the
  common single-band case.)
- **Touches:** `fpack/tile-source.ts` (`TilePyramid`), `fpack/worker-protocol.ts`,
  `renderer/tile-manager.ts` (upload queue), `renderer/viewer.ts` (drain in draw).
- **Tests:** pure `routeWorker(level,x,y,N)` distribution + determinism; fake pool
  of in-process scopes; upload-queue drain caps per frame; dedup still routes
  duplicates to one worker.

### P5 — Prefetch ring  *(additive; warms disk + GPU ahead of panning)*
- **What:** pure `ringTiles(geom, bounds, margin)` beside `visibleTiles`; after the
  visible pass, request the 1-tile margin at **low priority, gated on camera-idle**
  (short debounce). Prefetched tiles populate disk too.
- **Touches:** `renderer/tile-manager.ts`, `renderer/viewer.ts`; needs a priority
  lane so prefetch never starves visible fetches (a per-pyramid concurrency cap).
- **Tests:** `ringTiles` geometry; prefetch yields to visible requests.

### P6 — Request cancellation + Cloudflare versioning  *(optional; orthogonal)*
- **Cancellation:** thread `AbortSignal` `request → getTile → fetch({signal})`;
  `{type:'cancel', id}` worker message; abort tiles that leave `visibleTiles`.
  Swallow `AbortError`; small grace for pan-jitter.
- **CF versioning:** `pyramid_gen` stamps `build_id` into the manifest →
  `immutable` versioned paths (`/pyramid/<build_id>/…`) + Cache Reserve for the
  native level; the same `build_id` becomes the disk-cache fingerprint (replaces the
  manifest-hash from P2). Add a startup Range/206 self-check.
- **Touches:** cancellation across `tile-manager.ts`/`tile-source.ts`/`worker*.ts`/
  `fpack-file.ts`; `pyramid_gen` manifest writer + CF config (no client change for
  versioning beyond using the new fingerprint).

---

## Files-touched matrix

| Phase | New | Modified |
|---|---|---|
| P0 | — | `renderer/viewer.ts` (+`tile-manager.ts`) |
| P1 | — | `fpack/fpack-file.ts` |
| P2 | `fpack/blob-store.ts`, `fpack/idb-blob-store.ts`, `fpack/cache-size.ts` | `fpack/tile-source.ts`, `worker.ts`, `fpack/worker-protocol.ts` |
| P3 | — | `fpack/fpack-file.ts`, `fpack/tile-source.ts`, `fpack/idb-blob-store.ts` |
| P4 | — | `fpack/tile-source.ts`, `fpack/worker-protocol.ts`, `renderer/tile-manager.ts`, `renderer/viewer.ts` |
| P5 | — | `renderer/tile-manager.ts`, `renderer/viewer.ts` |
| P6 | — | `tile-manager.ts`, `tile-source.ts`, `worker*.ts`, `fpack-file.ts`, `pyramid_gen/*` |

## Testing strategy
- **Bit-exact gate preserved:** P1 is a pure refactor; P2/P3 only substitute the
  *source* of identical compressed bytes — decode is never touched. Add explicit
  round-trip tests (fetch→store→reload→decode == direct decode).
- **No new deps:** `BlobStore` interface + in-memory impl for Node tests; fake
  worker pool via in-process scopes (the existing `attachTileWorker` is already
  transport-agnostic for exactly this).
- **Pure-logic units:** key derivation, disk-LRU eviction, budget sizing, worker
  routing, ring geometry, upload-queue drain — all Node-testable without IDB/GL.
- Keep `npm run bench` as the decode-cost regression check; add a pool-vs-single
  warm-reload bench if useful.

## Open decisions (need your call)
1. **Pool shape.** Recommended **Shape A** (N full `TileEngine`s, key-hash routed —
   minimal churn). The wrinkle: on a *truly cold* dataset, N workers may each open
   the same level (N× head+index fetch) since routing spreads a viewport's tiles
   across workers. Mitigations: (a) accept it — it's one-time-per-level and warm
   reloads dedupe via the P3 disk meta store; or (b) **Shape B** — main thread opens
   each level once (cheap, async) and passes per-tile `decodeParams` to stateless
   fetch/decode/disk workers (cleaner, bigger refactor, also kills the `slice()`
   clone). I lean A + P3; switch to B if cold-start metadata amplification matters.
2. **Disk budget + opt-in.** Default target (~1 GB capped by `estimate()*fraction`),
   and whether the disk tier ships **on by default** or behind a flag for the first
   release.
3. **Fingerprint now vs. `build_id` later.** Start with a manifest-content hash
   (no `pyramid_gen` change), add `build_id` in P6? (Recommended.)

## Suggested first PR
**P0 + P1 together**: the user-visible quick win (no more black-on-load) plus the
zero-risk refactor that opens the cache seam. Then P2 as its own PR (the real
feature), then P4.
