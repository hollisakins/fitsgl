# FITSGL client performance — caching, concurrency, progressive rendering

**Status:** investigation only — no production code changed. Prepared to decide
where to invest in client interactivity (DS9-style smooth pan/zoom over gigapixel
mosaics served from R2/Cloudflare over HTTP range requests).

**Method.** Every claim is grounded in the actual TypeScript (`fitsgl-core/src`,
`demo/`) with `file:line` citations, cross-checked by an independent adversarial
pass. Concurrency was **measured**, not inferred: an instrumented probe
(`fitsgl-core/concurrency-probe.mjs`, added for this report — safe to delete)
drives the real inline `TileEngine` over the demo pyramid and counts in-flight
fetches; decode cost was taken from the repo's `vitest bench`. Where a conclusion
depends on real network/transport behavior the Node probe cannot exhibit
(HTTP/1.1 vs HTTP/2 connection limits, Cloudflare edge behavior), it is labelled
analysis, not measurement.

---

## TL;DR

| # | Area | Verdict |
|---|------|---------|
| 1 | **Caching — two-tier?** | **Half.** Two *in-memory* tiers exist (decoded-tile LRU + GPU textures); **zero persistent tier** (no IndexedDB/Cache API/OPFS), no `storage.estimate()`/`persist()`. |
| 2 | Request concurrency | **Good engine, transport-bound.** Visible tiles dispatch fully concurrently with **no cap** (measured 16 & 25 in-flight); real ceiling is the browser/transport. No range coalescing; 1–2 cold-start metadata RTTs per level. |
| 3 | Progressive / never-blank | **Partial.** Single-band blur-to-sharp works *only if a coarse ancestor is already resident*; **cold start and pan-into-new-territory are blank** (no single-band prime). RGB is protected. **No prefetch ring anywhere.** |
| 4 | Decode / main-thread | **Off-thread but serial.** Decode is in a Web Worker (one per band → single-band = 1 worker). A viewport burst **serializes** (~3 ms/tile). Texture upload is per-tile on the **main thread**, unbatched. |
| 5 | Cloudflare edge | **Unbuilt + at risk.** No production config exists. Per-tile Range into one large per-level object; the big object likely **silently bypasses the edge** without Cache Reserve + versioned `immutable` paths. Client can't tell HIT from MISS. |
| 6 | Other | **No request cancellation** (pan-away wastes fetch+decode+upload), ~2× over-fetch under North-up rotation, no coalescing. Dedup is tight. |

---

## The two highest-impact gaps

### A. The "warm" story is fragile end-to-end — no durable cache, and the edge tier it relies on isn't guaranteed to cache

The targets ask for **two** client caches (in-mem/GPU LRU **and** a persistent
~1 GB IndexedDB tier) plus Cloudflare edge as the top tier. Today:

- There is **no persistent client tier of any kind** — repo-wide grep finds no
  IndexedDB, Cache API, OPFS, or `localStorage`, and nothing calls
  `navigator.storage.estimate()`/`persist()`. Every page reload, and every revisit
  to a region after LRU eviction, **re-fetches and re-decodes from scratch.**
- The project has an explicit, *deliberate* design stance that makes this a
  decision rather than an oversight: `notes/phase4.md` states **"the CDN caches
  bytes; the client caches compute,"** calling an in-app compressed-byte cache
  "redundant." (Note: the "~1 GB IndexedDB" figure is the brief's target, not a
  documented repo decision.)
- But that stance only holds if the CDN tier actually caches — and **no production
  Cloudflare/R2 config exists**, file paths are **unversioned**, the client sets
  **no cache headers** (and can't — `Cache-Control` is origin-set), and the most
  expensive object (the native level) is exactly the case where Cloudflare will
  **serve Range requests by forwarding to origin instead of caching** unless Cache
  Reserve / tiered cache + `immutable` versioned paths are configured. The client
  requires a `206` but never inspects `CF-Cache-Status`, so a **silent edge bypass
  is invisible** to the app.

**Net:** "warm" currently means "still in this tab's RAM." Across reloads/sessions
it depends entirely on the browser HTTP cache (best-effort, no `persist()`) and an
edge tier that is neither built nor guaranteed to cache the big object. Pick one:
**(a)** commit to the CDN-as-byte-cache design and *make it real* (§5), or **(b)**
add a persistent client tier (§1). Doing neither leaves the headline interactivity
promise unmet across the most common real-world action — coming back later.

### B. Cold start and panning still show blank, and a viewport's decode is serialized on one thread

Two things break "an uncached tile visible within 100–200 ms; **perceived latency
~0** via coarse-to-fine":

- **Single-band has no coarse prime.** Only RGB primes the coarsest tile
  (`viewer.ts:377-379`). A fresh single-band viewer's first frame targets a *mid*
  level (z2–z3 for the 8096² demo), nothing is resident, and `coarserFallback`
  starts at `level+1` — so the canvas is **fully black** for one full fetch+decode
  cycle. The same blank appears when panning at fine zoom into regions whose coarse
  ancestors were never drawn or have been evicted. The blur-to-sharp machinery is
  real but only fires when a coarser parent *happens* to still be resident.
- **No prefetch ring** anywhere (grep-confirmed): only currently-visible tiles are
  requested, so the leading edge of every pan is a cold round-trip.
- **Decode serializes per band.** Decode runs off-main-thread, but in **one worker
  per `TilePyramid`** (single-band = 1 worker; RGB = 3, one per band). A ~25-tile
  viewport burst decodes one tile at a time (~3 ms each → ~75 ms of serial worker
  CPU before the last fine tile), and texture upload then runs per-tile on the
  **main thread** with no batching.

**Net:** the cheapest, highest-visibility fix is a **single-band coarse prime**
(1–3 lines, mirrors RGB) so the first paint is an instant blurry whole-image
preview instead of black. Prefetch + a small worker pool address the rest.

---

## 1. Caching — is it actually two-tier?

### Current behavior

**Two in-memory tiers, zero persistent tiers.**

- **Tier 1 — decoded-tile LRU** (`TileEngine.cache`, `fpack/tile-source.ts:39,46`):
  `LRUCache<string, Float32Array>`, key `"${level}/${tileX}/${tileY}"`, default
  capacity **256** (`worker-protocol.ts:9` `DEFAULT_CACHE_SIZE`). Plain
  insertion-order Map LRU (`lru.ts:20-40`). Holds **decoded** floats — the
  compressed RICE bytes are fetched per-tile and **discarded after decode**
  (`fpack-file.ts:278,287`). Lives **inside the worker** (or inline when fetchers
  are injected). The worker transfers a `slice()` **clone** so the cached copy
  survives (`worker.ts:47-49`).
- **Tier 2 — GPU texture cache** (`TileManager.textures`, `tile-manager.ts:266`):
  `Map<string, TileTexture>`, same key (`tileKey`), uploaded as R32F
  (`gl-util.ts:99`). Eviction is the pure `selectEvictions` policy
  (`tile-manager.ts:231-250`): drop tiles idle > **60 frames** (`MAX_IDLE_FRAMES`),
  then budget-LRU down to **200 tiles/band** (`DEFAULT_TEXTURE_BUDGET`), **never**
  evicting a current-frame tile. One manager **per band** (`viewer.ts:370-372`), so
  RGB holds ~3×. Runs every *drawn* frame (`viewer.ts:905`; the loop is on-demand,
  not a continuous 60 Hz tick).

**Byte sizing.** A full 256² R32F tile = **256 KiB** decoded **and** 256 KiB on the
GPU (edge tiles smaller). At defaults: GPU ≈ 50 MB/band, decoded ≈ 64 MB/band →
~**114 MB** single-band / ~**342 MB** RGB. The demo raises these (GPU 400 / decoded
800 → ~300 MB / ~900 MB). All volatile RAM/VRAM.

**Persistent tier — absent.** Repo-wide grep: no `indexedDB`, `caches.`,
`CacheStorage`, OPFS, `localStorage`, `navigator.storage`, `estimate()`,
`persist()`, no Service Worker. (The one `estimate` hit is an unrelated comment in
`overlay/markers.ts:323`.) Because both tiers are in-RAM Maps, **incognito behaves
identically** — works for the session, lost on close, no quota interaction.

*Implicit third layer:* `httpRangeFetch` issues `fetch(url, {headers:{Range}})`
with **no `cache:` directive** (`fpack-file.ts:41`), so the **browser HTTP cache**
is the de-facto persistence layer today — best-effort, unsized, no `persist()`.

### Gap vs targets

- ✅ Two in-memory tiers, both LRU, both keyed `(level,i,j)`, footprint in the
  256–512 MB ballpark.
- ❌ **No persistent tier.** The single biggest gap, and the one that makes
  "revisiting a region doesn't re-fetch" false across eviction/reload.
- ❌ The cache stores **decoded floats (256 KiB)**, not compressed blobs
  (~44–90 KiB) — so even in-memory tiers are ~3–5× larger per tile than the
  compressed-blob target, and there is nothing on hand to write to disk without
  retaining the raw range bytes.
- ❌ Fixed sizes (256/200), no `storage.estimate()` sizing, no `persist()`.
- ⚠️ Working set is "visible + already-resident-coarser," narrower than the
  target's "visible + neighbor + one-level-up" (no prefetch — see §3).

### Recommendations

| Change | Impact | Effort | Tradeoffs / touches |
|---|---|---|---|
| **Persistent compressed-blob tier** in IndexedDB (hand-rolled, no deps per CLAUDE.md), keyed `(manifestVersion, level, i, j)` holding raw RICE bytes; check before `httpRangeFetch`, write back after. Run in the worker. | **High** — revisits/reloads serve from disk; ~3–5× more tiles/MB than decoded. | Med-High | Requires **retaining raw range bytes** (currently discarded post-decode); async IDB get on each miss; quota + incognito handling; invalidate on manifest version. Touches `fpack/fpack-file.ts`/new `fpack/tile-cache.ts`, `worker.ts`, `tile-source.ts`. |
| **Dynamic sizing + durability:** size tiers from `navigator.storage.estimate()`, call `navigator.storage.persist()` at init; fall back to fixed defaults when absent. | Med | Low | `estimate()`/`persist()` are no-ops/denied in some private modes — guard with `typeof` checks. Touches `worker.ts` init, `tile-source.ts`. |
| **Service-Worker + Cache API** as a lower-friction alternative: cache the 206 range responses transparently (keyed by URL+Range), no decode-path rewrite. | Low-Med | Med | Range + Cache API is browser-inconsistent; SW absent in some private modes; less control than IDB. New `sw.ts` + registration. |
| If persistent tier is deferred, **store compressed bytes alongside decoded floats** in the in-mem tier and **raise demo defaults**, so at least same-session revisits avoid re-decode. | Low | Low | Memory vs re-decode tradeoff. Touches `tile-source.ts`. |

---

## 2. Request concurrency

### Current behavior (measured)

**Fan-out is genuinely concurrent, uncapped.** The draw loop iterates visible
tiles in a plain `for`-loop calling `mgr.request(...)` with no `await` between
iterations (`viewer.ts:970-991`, `1023-1028`); `request()` fires
`pyramid.getTile(...).then(...)` and returns immediately (`tile-manager.ts:292-329`).
So every visible tile's promise is dispatched in one synchronous tick.

**Probe results** (`concurrency-probe.mjs`, real inline engine over the demo):

```
z3 cold, 16 tiles fired at once : 1 head fetch (0.7→26.8ms) THEN 16 tile fetches
                                  dispatched together @27.6ms — max concurrent = 16
                                  wall 113ms vs 425ms-if-serial
z2 cold, 25-tile viewport       : max concurrent = 25  (no cap)
z3 warm re-request              : 0 fetches (decoded LRU hit)
```

No semaphore/queue/cap exists anywhere (grep-confirmed).

**Cold-start serialization.** Before the first tile of a not-yet-opened level there
are **two serialized awaits**: `fileForLevel`→`FpackFile.open` (one 16 KB head
fetch, `tile-source.ts:87`, `fpack-file.ts:147`) then `loadTileIndex`
(`fpack-file.ts:261`). All N tiles share these single promises, then the heap
fetches fire together. An independent probe on the demo **z0** confirmed **18
fetches** for a cold 16-tile viewport: the row table ends at byte **16832 — 448 B
past the 16 KB head** — forcing a **separate index fetch** (and `getBytes`
re-fetches the *whole* 8 KB range, not just the missing 448 B). So z0 pays **two
serial RTTs** before any pixel; coarser levels fit in the head (1 RTT).
*(Correction to an earlier assumption: the "~3.8 MiB descriptor table" is the
COSMOS-Web **single-file** design, not this per-level layout — the demo z0 table is
only 8 KB.)*

**No range coalescing.** Each `getBytes` is exactly one Range request
(`fpack-file.ts:183-194`); sequential row-major tiles are byte-contiguous in the
heap yet fetched individually.

**De-dup at 3–4 layers, each justified:** `TileManager.inflight` + GPU-residency
check (`tile-manager.ts:294`); `TilePyramid.inflight` (worker-mode only — also
dedups the `autoStretch` caller that `TileManager` can't see, `tile-source.ts:218-236`);
`TileEngine.inflight` (`tile-source.ts:81-97`); plus `FpackFile` open/index promise
sharing. None redundant.

### Gap vs targets

- ✅ Concurrent, uncapped, deduped; warm hits cost 0.
- ⚠️ **The real ceiling is the transport, not the engine.** The Node probe has no
  connection limit; a real browser caps **~6 concurrent per origin on HTTP/1.1**.
  **The Vite dev server is HTTP/1.1**, so a 25-tile cold viewport serializes into
  ~5 waves of 6 (~200–300 ms of tile RTT alone, plus 1–2 metadata RTTs) — **breaking
  the <300 ms cold-fill target**. Over **HTTP/2/3** (one multiplexed connection,
  which Cloudflare serves) all 25 fire in one wave and the target is reachable.
  *Anyone benchmarking cold-fill against the dev server will see 6-at-a-time waves
  and wrongly blame the engine.*
- ❌ No coalescing leaves RTT/overhead on the table (big win on H1, smaller on H2/3).
- ⚠️ z0's second metadata RTT is needless — caused only by the 16 KB head default.

### Recommendations

| Change | Impact | Effort | Tradeoffs / touches |
|---|---|---|---|
| **Serve production over HTTP/2 or /3** (Cloudflare already does); document that the HTTP/1.1 dev server is *not* representative; add an H2 preview for local cold-fill benchmarks. | **High** — transport is the binding constraint for <300 ms. | Low | Deploy/doc only; no library code. |
| **Enlarge `FpackFile.open` initial head** to cover the BINTABLE row table for typical levels (or pass a per-level size hint from `rowBytes*nRows`). For demo z0, ≥16832 B folds the index into the head and removes a full RTT + the redundant 8 KB GET. | Med | Low | Over-fetch a few KB on tiny levels; don't inline genuinely huge single-file tables. Touches `fpack/fpack-file.ts`, `tile-source.ts`. |
| **Coalesce contiguous heap ranges** into one Range request (`getTiles(coords[])` that sorts by `heapOffset`, merges runs under a gap/byte cap, slices per tile). | Med-High on H1, Low-Med on H2/3 | High | Tiles in a run arrive together (less per-tile progressive paint); must preserve per-tile dedup + LRU keying and thread through the worker protocol. Touches `fpack-file.ts`, `tile-source.ts`, `worker-protocol.ts`, `worker.ts`, `tile-manager.ts`, `viewer.ts`. |

---

## 3. Progressive / "never show blank" rendering

### Current behavior

- **Single-band blur-to-sharp — present but conditional.** For each visible tile
  not yet resident, `drawSingleBandTiles` requests it and draws the best resident
  coarser ancestor via `coarserFallback` over a `fallbackUV` sub-rect
  (`viewer.ts:977-990`). `coarserFallback` is a true **chain** — walks `level+1 …
  maxLevel`, returns the finest resident ancestor (`tile-manager.ts:149-163`).
- **When no ancestor is resident → blank.** `coarserFallback` returns `null` and
  the draw is guarded `if (fb !== null)` with **no else** (`viewer.ts:982`) — the
  cleared black canvas shows through. Single-band has **no cold-start prime**: only
  RGB primes `maxLevel,0,0` (`viewer.ts:377-379,601-603`). The first single-band
  frame targets a *mid* level (z2 for large windows, z3 for typical laptop windows
  — never the coarsest), so a fresh viewer is **fully black** until those ~16 tiles
  fetch+decode. Same for panning at fine zoom into territory whose ancestors were
  never drawn or were evicted (60-idle / budget eviction can drop the safety net).
- **RGB is protected.** `commonResidentLevel` *includes* the target level and the
  `maxLevel,0,0` prime guarantees a whole-image ancestor is loading; once it lands,
  every tile has a common ancestor (common-level-hold, `viewer.ts:1034-1040`). The
  primed tile is re-`acquire`d each frame so it survives eviction.
- **No prefetch ring** (grep-clean across `src/` and `react/`): every `request()`
  targets a currently-visible tile or the RGB prime. `visibleTiles`
  (`tile-manager.ts:114-141`) has no margin.
- **Refinement loop is correct:** each arriving tile fires `onTileLoaded` →
  `requestRender` → one coalesced frame that replaces the coarse stand-in
  (`tile-manager.ts:321`, `viewer.ts:859-863`).

### Gap vs targets

- **Gap A — cold-start & fine-pan blank (single-band).** Blur-to-sharp only helps
  when a coarse ancestor is already resident; on first paint none is, so the user
  sees black for a full fetch+decode cycle — fails "perceived ~0." A one-line
  asymmetry vs RGB, not a deep design problem.
- **Gap B — no prefetch ring.** The leading edge of every pan/zoom is a fresh
  round-trip; nothing warms the next ring before it scrolls in. The targets
  explicitly want "1–2 tiles beyond the viewport." (Fetch *parallelism* is already
  fine — the missing piece is purely speculative lookahead.)

### Recommendations

| Change | Impact | Effort | Tradeoffs / touches |
|---|---|---|---|
| **Single-band cold prime:** also `request(maxLevel,0,0)` when `mode==='single'` (drop the RGB-only guard) **and re-`acquire` the coarsest tile each frame** so it survives 60-idle eviction (as RGB does). | **High** — kills the "black screen on load" defect; instant blur preview. | Trivial (1–3 lines) | One extra coarsest fetch (already paid in RGB); optionally pin `level===maxLevel` from eviction. Touches `viewer.ts` (~377/601), optionally `tile-manager.ts`. |
| **Pre-warm the parent chain:** when requesting a missing fine tile, also request its immediate `level+1` parent if absent — cheap, heavily deduped (siblings share a parent). | Med | Low | Modest extra fetches. Touches `viewer.ts` draw loops. |
| **Prefetch ring:** new pure `ringTiles(geom,bounds,margin)`; request the 1-tile margin at **low priority, gated on camera-idle** so it never starves visible fetches. | Med-High | Med | Larger working set; needs a priority lane + concurrency cap (current `request()` has no priority). Touches `tile-manager.ts`, `viewer.ts`, tests. |
| **Protect coarse levels from eviction** (longer idle / reserved budget for high-z levels) so the fallback survives deep-zoom panning. | Med | Low | Slightly higher steady-state count (negligible — z5=1 tile, z4=4…). Touches `tile-manager.ts`. |

---

## 4. Decode pipeline / main-thread blocking

### Current behavior

- **Decode is off the main thread, in one worker *per band*.** `TilePyramid`
  spawns a single module Worker by default (`tile-source.ts:148-151`); RGB mode
  builds 3 `TilePyramid`s (`render-source.ts`, `viewer.ts:373`) → **3 workers**, so
  decode parallelizes up to 3-way *across bands* but is **serialized within a
  band** (single-band = 1 worker). The worker's `onmessage` fires `void handle()`
  per message; `handle` awaits a CPU-bound decode that does not yield
  (`worker.ts:25-53`). No worker pool, no `navigator.hardwareConcurrency`.
- **Per-tile decode cost** (repo `vitest bench`, 256² fixtures, this machine):
  RICE_1 ≈ **3 ms/tile** (the dither variant is within noise — RICE dominates,
  dequant is negligible), GZIP_2 ≈ 1.1 ms. A ~25-tile single-band burst ≈ **~75 ms
  of serialized worker CPU** before the last fine tile; a full 1024-tile z0 decode
  ≈ ~3 s of worker CPU.
- **Texture upload is on the main thread, per-tile, unbatched, unthrottled.**
  Each resolved tile runs `createTileTexture` → `gl.texImage2D(R32F, …)` (256 KB)
  inside its `.then` (`tile-manager.ts:314`, `gl-util.ts:96`); it is a full upload,
  not `texSubImage`/PBO. N near-simultaneous arrivals = N `texImage2D` calls + **one**
  coalesced rAF (`renderScheduled`). Today the single worker staggers arrivals
  ~3 ms apart so uploads spread out; a future warm cache (IndexedDB) would deliver
  many in one tick and **expose the unbatched upload** as a frame stall.
- **Worker clone:** `tile.slice()` is a 256 KB copy on the worker thread per
  reply, to keep the LRU entry from detaching on transfer (`worker.ts:47-49`); the
  main thread wraps the transferred buffer as a zero-copy view (`tile-source.ts:197`).
- **`draw()` main-thread work** is O(visible tiles) GL draw calls (no per-pixel
  work) plus an unconditional per-frame `evict()` rebuild+sort per band
  (`viewer.ts:905`, `tile-manager.ts:332-345`) — cheap (~200–600 entries) and only
  on drawn frames.

### Gap vs targets

- ✅ **60 fps for loaded content:** met in steady state (no decode in `draw`). ⚠️
  a *burst* of simultaneous uploads (the warm-cache future) can blow 16 ms.
- ⚠️ **100–200 ms uncached tile / perceived ~0:** a single coarse tile is fine and
  coarse-to-fine hides latency, but the *full* fill is gated by serialized decode.
- ⚠️ **Cold <300 ms:** fetches overlap, but **decode does not parallelize within a
  band** — ~75 ms serial decode is a large fraction of 300 ms and grows with tile
  count and DPR (`hiDpiLevels` ≈ 4× tiles).

### Recommendations

| Change | Impact | Effort | Tradeoffs / touches |
|---|---|---|---|
| **Worker pool** (≈`hardwareConcurrency`, capped ~4) sharding tiles by key, each hosting a `TileEngine`, so a within-band burst decodes in parallel. | **High** — turns ~75 ms serial into ~75/N ms; lifts the single-core ceiling. | Med-High | Per-worker LRU duplicates cache + N× metadata fetch unless a main-side router/shared cache is added (`TilePyramid` already dedups in worker mode — keep it, route by key). Touches `tile-source.ts`, `worker.ts`, `worker-protocol.ts`. |
| **Throttle/time-budget texture uploads:** queue resolved tiles, upload ≤ a few ms (or ~8 tiles) per rAF, defer the rest (coarse fallback keeps it invisible). | Med-High (esp. once a warm cache exists) | Med | One extra frame of latency for spilled tiles; must coordinate with eviction. Touches `tile-manager.ts`, `viewer.ts`. |
| **Drop the worker-side `slice()` clone** by caching compressed bytes (re-decode on miss) or transferring the canonical buffer and dropping it from the LRU. | Low-Med | Low-Med | Trades a guaranteed cache hit for possible re-decode; probably not worth it until the pool exists. Touches `worker.ts`, `tile-source.ts`. |
| **Skip per-frame `evict()`** when under budget and nothing crossed the idle threshold (or maintain incremental LRU order). | Low | Low | Keep `selectEvictions` unit-testable; just call it less. Touches `tile-manager.ts`. |

---

## 5. Cloudflare edge caching (production)

### Current behavior

- **Nothing production is implemented.** No Cloudflare/R2/wrangler/`_headers`
  config exists (only `fitsgl-py/pyproject.toml`). All deployment guidance is
  prose in `notes/phase4.md` ("Production deployment (R2 + Cloudflare)"). The
  **browser cache/revalidation path is emulated** in working code, though:
  `demo/vite.config.ts` sets `Accept-Ranges`, an `ETag` from size+mtime,
  `Cache-Control: no-cache`, and answers `If-None-Match` → 304.
- **Request model:** each pyramid **level is a separate object**
  (`tile-source.ts:64-77`, one `FpackFile` per level via `resolveLevelUrl`). A tile
  = **one HTTP Range request** into that level's single `.fits.fz`
  (`fpack-file.ts:277-278`), plus a one-time ~16 KB head + index fetch per level.
  The alternative under consideration (one file per *filter*, one HDU per level)
  keeps the per-tile Range pattern but makes an even larger object — raising the
  Cache-Reserve question, not lowering it.
- **Client cache headers:** the client sets **none and cannot** — `Cache-Control`
  is an origin response header. The sole tile fetch sends only `Range`
  (`fpack-file.ts:41`); the manifest fetch sends nothing (`manifest.ts:133`). The
  client **requires `206`** and hard-rejects `200` (`fpack-file.ts:42-49`) — which
  is the *correct* contract (a CDN returns 206 for satisfied ranges whether HIT or
  MISS) — but it **never reads `CF-Cache-Status`/`Content-Range`**, so it **cannot
  distinguish an edge HIT from a silent origin bypass.**
- **Versioning:** filenames are stable/unversioned (`resolveLevelUrl`), so the
  planned `immutable` + versioned-path scheme is **prose only**; the practical
  fallback is per-object revalidation (an edge round-trip even on hits).

### Gap vs targets — would the edge warm or bypass?

The sharp edge is **Range-request caching of a large object.** Cloudflare serves
Range requests, but to satisfy an *arbitrary* byte range **from the edge** it
generally needs the **whole object cached**; large objects can exceed default cache
size limits and be served by **range-forwarding to origin (R2) — a silent MISS**.
The native level is exactly this danger zone (the demo's z0 is ~178 MB, *though
that figure is inflated because the demo z0 is still GZIP_2 lossless; the shipping
all-RICE q8 z0 would be smaller and may fall under the auto-cache limit*).

**Verdict:** as planned (no config), small/coarse levels will cache and warm fine,
but the dominant native-level object will **likely silently bypass the edge**
unless Cache Reserve / tiered cache **and** `immutable` versioned paths are
explicitly configured — and the client has no signal to tell you which is
happening.

### Recommendations

| Change | Impact | Effort | Tradeoffs / touches |
|---|---|---|---|
| **Write origin cache headers + versioned paths:** `.fits.fz` → `Cache-Control: public, max-age=31536000, immutable`, cache-bust by **path** (`/pyramid/<build-id>/<band>/…`); manifest → `no-cache` + `ETag`. Emit the build-id segment in `fitsgl`. | **High** — turns "maybe warms" into "reliably warms," removes revalidation round-trips and the stale-on-rebuild hazard. | Med | Each rebuild publishes a new prefix (update pointer, GC old builds); `immutable` is unforgiving on id reuse. Touches `fitsgl`, Cloudflare config; client unaffected. |
| **Cache Reserve / tiered cache for the native level**, then **verify** a tile Range returns `206` + `CF-Cache-Status: HIT` after warm-up. | High | Low-Med | Storage/op cost, plan-gated; the all-RICE z0 may not need it once it's smaller. Cloudflare config. |
| **Edge HIT/MISS observability:** optional debug fetcher reads `CF-Cache-Status`/`Age` and surfaces via the existing `onFrame`/HUD. | Med | Low | Needs `Access-Control-Expose-Headers` on origin; keep debug-only. Touches `fpack-file.ts` (or demo wrapper). |
| **Decide the persistent-cache stance explicitly:** either formally adopt "CDN/browser HTTP cache is the persistent byte cache" (and drop the IndexedDB target), or add a client tier as a fallback for edge bypass (§1). | Med | (a) Low / (b) High | (a) leaves no client fallback if the edge misses; (b) reintroduces what `phase4.md` calls "redundant." Docs + maybe `fpack-file.ts`. |
| **Make Range + cacheability a self-checked contract:** SSG/startup probe asserts `206` + `Accept-Ranges` (+ HIT on a second fetch in prod). | Med | Low | One extra startup round-trip; gate to dev/CI/first-load. Touches `fitsgl` SSG. |

---

## 6. Other latency / throughput issues

### Current behavior

- **No request cancellation on pan-away.** No `AbortController`/`AbortSignal`
  anywhere (`httpRangeFetch` passes no `signal`, `fpack-file.ts:41`). Once
  `request()` enters its `.then`, the fetch + RICE decode + GPU upload **complete
  regardless of viewport**; only `this.destroyed` gates the upload
  (`tile-manager.ts:298-322`). The stale tile installs into **both** caches and
  occupies the 200/band GPU budget for up to **60 frames (~1 s)** — during a fast
  pan this churns the budget and can evict genuinely useful coarse ancestors.
  *(The decoded LRU evicts by capacity, not idle frames — two different policies.)*
- **Over-fetch under rotation.** Unrotated: no over-fetch (`visibleTiles` even
  nudges the exclusive edge inward, `tile-manager.ts:127-132`). With **North-up
  on**, tiles are selected from the rotated viewport's **AABB**
  (`viewer.ts:883`) → up to **~2.0× (square) / ~2.17× (16:9) / ~2.25× (2:1)** the
  visible area; corner tiles are fully fetched/decoded/uploaded/budgeted though
  off-screen. The roadmap accepts this for *correctness*, but it's a throughput cost.
- **Dedup is tight** (§2) — no re-fetch of a tile already in GPU or decoded LRU; the
  3–4 layers are at distinct scopes/threads and each earns its keep.
- **`setSource`** destroys old managers without aborting their in-flight fetches;
  the `.then` early-returns on `destroyed` (wastes fetch+decode, but doesn't upload).
- **No coalescing**, **no prefetch** (§2, §3).

### Gap vs targets

- ❌ **Cancellation missing** — the dominant wasted-work source on fast pans (spends
  the one decode thread on tiles the user already left).
- ⚠️ **Tile size** — measured coarse RICE tiles are **~65–90 KiB** (a bit above the
  40–60 KiB assumption); the demo's ~170 KiB z0 is a **GZIP_2-lossless artifact**
  of stale demo data (predates the all-RICE q8 switch, HEAD `f7ef69d`). The
  single-file report cites ~44–48 KiB for a 256² q8 tile, so the shipping format is
  close to target.
- ⚠️ Rotation over-fetch up to ~2× under North-up.
- ❌ Persistent cache + prefetch absent (covered in §1/§3).

### Recommendations

| Change | Impact | Effort | Tradeoffs / touches |
|---|---|---|---|
| **Per-request cancellation:** thread an `AbortSignal` from `request()` → `getTile` → `fetch({signal})`; on a draw where a previously-requested tile leaves `visibleTiles`, abort it. In worker mode, post `{type:'cancel', id}`. | **High** — eliminates the main wasted-work source on pans; frees the decode thread and stops budget churn. | Med | Swallow `AbortError` quietly; add a small grace for pan-jitter; a synchronous RICE decode can't be interrupted mid-call (abort only helps pre-resolve). Touches `tile-manager.ts`, `tile-source.ts`, `worker-protocol.ts`, `worker.ts`, `fpack-file.ts`. |
| **Cull rotation over-fetch:** rect-vs-rotated-quad test per AABB candidate before `request`/draw. | Med | Low | Slight per-frame CPU (negligible vs a decode); only matters under North-up. Touches `tile-manager.ts`, `viewer.ts`. |
| (See §1 persistent cache, §2 coalescing, §3 prefetch, §4 worker pool — the cross-cutting levers.) | — | — | — |

---

## Appendix — evidence artifacts & caveats

- **Concurrency probe:** `fitsgl-core/concurrency-probe.mjs` (run `node
  concurrency-probe.mjs` in `fitsgl-core/`). Drives the real inline `TileEngine`
  with an instrumented file-backed `RangeFetcher` (25 ms simulated RTT). Safe to
  delete — it imports only built `dist/` and the demo pyramid.
- **Decode cost:** `@fitsgl/core` `npm run bench` (`test/tile-decode.bench.ts`),
  256² fixtures.
- **Caveats / corrections folded in from verification:**
  - Decode is one worker **per band**, so RGB has up to 3-way cross-band
    parallelism; serialization is *within* a band.
  - The demo z0's large size (~170 KiB/tile, 178 MB object) is because it is still
    **GZIP_2 lossless** — stale relative to the all-RICE q8 pipeline now in HEAD.
  - The "~3.8 MiB descriptor table" belongs to the **single-file** design, not the
    per-level layout (demo z0 table = 8 KB).
  - The "~1 GB IndexedDB" target is from the brief; the repo's *stated* position is
    "CDN caches bytes; client caches compute" — the persistent-cache gap is a
    **design decision to make**, not merely an omission.
  - HTTP/1.1-vs-H2/3 wave timing is analysis (standard browser per-origin limits),
    not measured — the Node probe has no connection cap.
  - First-frame target level is z2 *or* z3 depending on window size; either way it's
    a mid level with no resident ancestor, so the cold-start blank holds.
