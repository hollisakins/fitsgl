# FitsGL Supertiles — chunked levels + pre-tiled input, one format

A **supertile** is a standalone `.fits.fz` holding a rectangular sub-block of one
pyramid level's render-tiles, plus a little placement metadata. This one
representation solves two problems with a single on-disk format and a single
client read path:

- **Problem A — large levels aren't edge-cacheable.** Cloudflare's CDN caches
  *whole objects* and won't cache anything over **512 MB** on Free/Pro/Business
  (verified — see `deploy-design.md` §4.3). With one `.fits.fz` per level, a
  COSMOS-Web `z0` is ~6 GB and `z1` ~1.5 GB, so their tiles would never edge-cache.
- **Problem B — pre-tiled input.** Surveys deliver a field as overlapping tiles
  (COSMOS-Web: ~20 tiles of ~19200×24910 px). The generator today reads exactly
  one FITS per band and cannot ingest a tiled mosaic.

Both reduce to the same act: *emit standalone fpack files that each cover a
tile-rectangle of a level.* This realizes roadmap **D14** (tiled-mosaic input).

Status: design only. Nothing here is implemented. Authoritative companion docs:
`deploy-design.md` (the 512 MB limit that motivates Problem A), `config-contract.md`
(the dataset/`fitsgl.json` wire format). Trust the code over this doc.

---

## 1. Current state, precisely (the single-file-per-level pipeline)

Verified against source; these are the assumptions a supertile design must change.

- **One input FITS per band.** `BandSpec.input` is a single `Path`
  (`config.py:71`), validated to exactly one existing file (`config.py:174-178`);
  `build_pyramid` reads it end-to-end via `_read_input` (`build_pyramid.py:410`).
  **No mosaicking, reprojection, or resampling** — the input is assumed already on
  one pixel grid. WCS is read (`build_pyramid.py:250`) and only *scaled* per level
  (`_scale_wcs`, `build_pyramid.py:98-117`), never reprojected; SIP/TPV distortion
  is rejected outright (`build_pyramid.py:203-256`). North-up is a viewport
  operation, never baked (roadmap D1).
- **Levels.** `N = ceil(log2(max(dims)/256))`, giving `z=0..N`
  (`build_pyramid.py:68-77`). `z0` passes the native mmap through with no copy
  (`build_pyramid.py:87-91`); each `z>0` is an **independent**
  `block_reduce(2^z, np.nanmean)` of the native array, not iterated from `z-1`
  (`build_pyramid.py:80-95, 316-323`). `block_reduce` **trims non-divisible
  remainders**, so level tile grids do **not** nest cleanly 2:1.
- **Each level → one `.fits.fz`.** A `CompImageHDU` BINTABLE: one row per 256×256
  render-tile in row-major order plus a heap of compressed bytes. Grid is
  `nTilesX = ceil(W/256)`, `nTilesY = ceil(H/256)` (`fpack-file.ts:147-148`); edge
  tiles are partial, never padded (`fpack-file.ts:280-284`); dims in `ZNAXIS1/2`,
  tile size in `ZTILE1/2` (`fpack-file.ts:138-142`).
- **Manifest = convenience index.** One `LevelInfo` per level:
  `{z, filename, compression, lossless, shape:[H,W], fpack_tile_count:[ny,nx],
  pixel_scale_arcsec, wcs}` (`manifest.ts:10-23`, `manifest.py:19-31`). No
  chunk/origin field.
- **Client resolution `(z,x,y) → (URL, byte range)`.** `getTile` → `fileForLevel`
  opens the *single* `FpackFile` whose `LevelInfo.z` matches
  (`tile-source.ts:62, 113-126`); `row = tileY*nTilesX + tileX`
  (`fpack-file.ts:303`); the descriptor at that row gives `heapOffset`+`nBytes`;
  range = `heapStart + heapOffset … +nBytes` (`fpack-file.ts:339`). Bounds-checked
  against one global `nTilesX/nTilesY` (`fpack-file.ts:296`).

**What does *not* change:** `tile-manager.ts` `visibleTiles`/`ringTiles` and the
coarse-fallback math iterate logical `(z,x,y)` over the level's *total* grid and
divide/multiply tile indices by `2^k`. As long as a level keeps advertising its
**total** `fpack_tile_count`, all of that is untouched — the change is confined to
the file-lookup layer (`fileForLevel`/`resolveTile`).

---

## 2. The unifying model: `GridSource` → supertile emitter

One abstraction at the core — *"give me the pixels for any rectangular window of
the dataset's global pixel grid"*:

```
GridSource:
  global_shape -> (W, H)            # the dataset's full virtual grid
  global_wcs   -> WCS               # shared projection of that grid
  read_window(x0, y0, w, h) -> ndarray

  ├─ SingleFitsSource   : window = memmapped array slice            (today's input)
  └─ PlacedTilesSource  : window = composited from the input tiles that
                          cover it, placed by integer ΔCRPIX, one winner
                          per pixel in overlaps                     (new, §4)
```

Everything downstream is identical for both sources:

1. **Supertile emitter.** For each level `z`, partition the level's render-tile
   grid into fixed `K×K`-tile blocks (§5 SP4). For each block, read its pixel
   window from the level's grid (native via `GridSource`; coarse via
   `block_reduce` of a native window, §8), and write a standalone `.fits.fz`
   containing just that block's render-tiles. Record the block's origin and size
   in the manifest.
2. **Manifest v2** (§6) — per level, a *list* of supertiles each with `tile_origin`
   + `tile_count`; the level keeps its *total* `shape`/`fpack_tile_count`.
3. **Supertile-aware client** (§7) — `(z,x,y)` → containing supertile → local row
   → today's heap/range/decode path. Confined to `fileForLevel`/`resolveTile`.

**The viewer cannot tell an auto-chunked level from a parsed pre-tiled one** —
both are just lists of standalone fpack files with placement metadata. That is the
unification.

---

## 3. Why we *re-tile* (the key subtlety)

The tempting shortcut "each input tile *is* a supertile" does **not** work. Render
tiles live on a fixed global 256-px lattice, but input-tile boundaries fall at
arbitrary pixel offsets: for COSMOS-Web the inter-tile step is `ΔCRPIX = 17300` px
= **67.6 render-tiles** — *not* a multiple of 256. So input tiles straddle the
render-tile lattice, and a render-tile near a seam draws pixels from two input
files.

Therefore the emitter always **re-tiles** the `GridSource` onto the global
256-lattice. This is lossless (integer pixel placement, no resampling — the q8
RICE quantization happens at fpack time exactly as today) and it is precisely what
makes Problem A and Problem B the *same* operation: in both cases we re-tile a
`GridSource` into byte-bounded supertiles; only the `GridSource` differs.

---

## 4. Coordinates: the COSMOS-Web placement math

Confirmed from two adjacent tiles' headers: the input tiles share `CTYPE`
(`RA---TAN`), `CRVAL` (150.1163213, 2.2009731), the `PC` matrix (a shared ~20°
rotation), and `CDELT` (0.03″/px), differing **only** in `CRPIX`. This is the
clean case: **a common pixel grid, integer phase.**

- **Global grid.** With shared `CRVAL`/`CD`, a tile's position in the common grid
  is `−CRPIX` (the shared reference sky point lands at the same global location in
  every tile). The dataset's global pixel grid is the bounding box of all placed
  tiles in that shared (rotated) frame. We **never materialize** it — the
  `PlacedTilesSource` reads windows on demand. The ~20° rotation is shared, so it
  is irrelevant to assembly; north-up stays a viewer concern.
- **Integer phase → seam-free.** Adjacent tiles step by exactly 17300 px (≈1900 px
  overlap), so overlapping pixels are the *same* samples. "Pick one" leaves no
  seam.
- **Overlap winner: interior-preference, seam at the midline** (SP3). Overlap
  pixels are *nearly* identical but can have edge effects, so each global pixel in
  an overlap is assigned to the tile in whose interior it sits (seam placed at the
  overlap midline). Trimming to disjoint coverage at parse time keeps the on-disk
  supertiles a clean partition, so the client lookup stays exact and
  priority-free.
- **Placement source = the WCS, not the filename.** Each tile's grid origin is
  computed from its `CRPIX`; the `B1/B2…` filename IDs are not relied upon.

---

## 5. Locked decisions

| # | Area | Decision | Reasoning |
|---|---|---|---|
| SP1 | Format | A **supertile** = standalone `.fits.fz` holding a contiguous rectangle of a level's render-tiles. The viewer reads it via today's per-file heap/range path. | Each `.fits.fz` is already self-contained with a per-file-relative heap (`fpack-file.ts:339`); only *placement* is new. |
| SP2 | Unification | Auto-chunking (A) and pre-tiled input (B) are the **same** re-tiling of a `GridSource` into supertiles; only `read_window` differs. | One generator path, one wire format, one client read path — the viewer can't distinguish them. |
| SP3 | Coverage | Supertiles are a **disjoint partition** of each level. Pre-tiled overlaps are **trimmed at parse time** (interior-preference, seam at midline). | Disjoint → exact, priority-free `(z,x,y)→supertile` lookup; integer phase makes the trim lossless and seam-free. |
| SP4 | Geometry | **Fixed `K×K`-tile blocks** (a generator parameter), *not* size-driven. | Per-tile compressed size is driven by (roughly uniform) noise, so a conservative fixed `K` stays safely <512 MB everywhere, and gives O(1) closed-form partitioning + a trivial emitter. |
| SP5 | Wire format stays general | The manifest records **explicit `tile_origin`+`tile_count` per supertile**; the client does a containment lookup and **never hardcodes `K`**. | Decouples the client from the generator's strategy: edge/partial blocks and the single-supertile level are one code path, and switching to size-driven later is a *generator-only* change — zero viewer/format impact. |
| SP6 | Safety net | After compression, **assert no supertile exceeds the byte budget**; error with "reduce block size" if it does. | Pathologically incompressible input is rare; a loud failure beats silently shipping an uncacheable file. (Auto-subdivide is a possible later refinement.) |
| SP7 | No reprojection | The grid is the **producer's responsibility**. We place tiles by their WCS and trust it; we do **not** reproject or resample. | Preserves roadmap D1 (no resampling) and the SIP/TPV rejection; keeps the parser a placement, not a coadd pipeline. |
| SP8 | Fail-fast input guard | A band's own input tiles **must share** `CTYPE`/`CRVAL`/`CD` (within tolerance); otherwise the build **errors clearly**. | We can't place mismatched-WCS tiles without reprojection (SP7); refuse garbage-in loudly rather than produce a scrambled mosaic. |
| SP9 | Quality preserved | Coarse levels are still `block_reduce`-from-native (not iterated z→z), streamed window-wise for bounded memory. | Keeps today's downsample quality and extends the existing z0 peak-memory work to arbitrarily large mosaics. |

**Out of scope:** WCS reprojection / drizzle / coadd, cross-band grid *enforcement*
(divergent band grids are surfaced by the existing "mixed grids warn" path,
`fitsgl_config.py:150-166`), and per-supertile size-driven packing (SP5 keeps the
door open without a format change).

---

## 6. Manifest v2

Per-level, the single `filename` becomes a `supertiles` array; the level keeps its
*total* geometry so the client's iteration/fallback math is unchanged.

```json
{
  "schemaVersion": 2,
  "band": "f277w",
  "levels": [
    {
      "z": 0,
      "compression": "RICE_1",
      "lossless": false,
      "shape": [H, W],
      "fpack_tile_count": [ny, nx],          // TOTAL level grid (unchanged meaning, [y,x])
      "pixel_scale_arcsec": 0.03,
      "wcs": { /* level WCS of the global grid, scaled via _scale_wcs */ },
      "supertiles": [
        { "filename": "f277w_z0_0_0.fits.fz",   "tile_origin": [0, 0],   "tile_count": [64, 64] },
        { "filename": "f277w_z0_64_0.fits.fz",  "tile_origin": [64, 0],  "tile_count": [64, 64] },
        // … tile_origin/tile_count are [x, y]; the level's full grid is paved by disjoint blocks
      ]
    },
    {
      "z": 6,
      "shape": [h, w], "fpack_tile_count": [ny, nx], "...": "...",
      "supertiles": [
        { "filename": "f277w_z6.fits.fz", "tile_origin": [0, 0], "tile_count": [nx, ny] }
      ]
    }
  ]
}
```

- `tile_origin = [tx0, ty0]` — the supertile's local `(0,0)` tile in the level's
  grid. **This is the one fact a `.fits.fz` cannot self-supply** (no tile-origin is
  stored on disk), so it lives in the manifest.
- `tile_count = [snx, sny]` — the supertile's own grid (also in its `ZNAXIS/ZTILE`,
  but carrying it avoids a round-trip just to choose a file).
- A small level is the **degenerate one-supertile case** (`tile_origin [0,0]`,
  `tile_count = fpack_tile_count`) — no special-casing in the client.
- **Back-compat:** a legacy v1 level (single `filename`, no `supertiles`) is read
  as one supertile at `[0,0]` covering `fpack_tile_count` — a small shim so already
  built datasets keep working.
- **Filename convention:** `{stem}_z{z}_{tx0}_{ty0}.fits.fz` for multi-supertile
  levels; `{stem}_z{z}.fits.fz` for single-supertile levels (back-compat).

---

## 7. Client changes (confined to the file-lookup layer)

- **`manifest.ts`** — `LevelInfo` gains `supertiles[]`; parse + the v1 shim.
- **`tile-source.ts`** — the per-level file map (`Map<number, FpackFile>`,
  `:62, 113-126`) becomes keyed by `(z, supertileIndex)`. `fileForLevel` is
  replaced by `resolveSupertile(z, x, y)`: find the supertile whose
  `[tile_origin, tile_origin+tile_count)` rectangle contains `(x,y)` (containment
  test; for fixed-`K` data this is also just `floor(x/K)`, but the client uses the
  general rectangle test so it never depends on `K`), then open that file.
- **`fpack-file.ts`** — `resolveTile` (`:292-307`) takes the supertile's local
  origin: local `row = (y−ty0)*snx + (x−tx0)` (`:303`), and the bounds check
  (`:296`) is against the supertile's own `snx/sny`. The heap/range/decode path
  (`:339`) is unchanged (already per-file-relative).
- **`tile-manager.ts`** — **untouched.** Visible-tile selection and the `2^k`
  coarse-fallback operate on logical `(z,x,y)` against the level's total grid.

A small caching note: tiles are still range-fetched **individually** from a
supertile, so there is no "fetch the whole chunk" cost — only one cheap BINTABLE
header read per supertile on first touch (memoized).

---

## 8. Generator architecture

**Python (`pyramid_gen`):**

- **Config** — `BandSpec.input` accepts a *list* / glob of FITS for pre-tiled
  input (single path stays valid). New validation: SP8's shared-WCS guard across a
  band's tiles.
- **`GridSource`** — new abstraction (§2). `SingleFitsSource` wraps the existing
  memmap slice; `PlacedTilesSource` computes each tile's global offset from
  `CRPIX`, exposes `global_shape`/`global_wcs`, and `read_window` gathers from the
  covering tile(s) applying SP3's interior-preference winner. Memmaps inputs;
  assembles windows on demand.
- **Supertile emitter** — replaces "write one `.fits.fz` per level." For each
  level: compute the level grid; for native, read windows from the `GridSource`;
  for coarse, `block_reduce(2^z)` a native window (SP9), streamed in strips so peak
  memory stays bounded regardless of mosaic size (extends the z0 memory work). Cut
  into `K×K` blocks; fpack each block as a standalone `.fits.fz`; assert SP6;
  record `tile_origin`/`tile_count`.
- **`manifest.py`** — emit v2 `supertiles[]`.

**Decode-correctness fixtures are unaffected** — each supertile is a standard
`.fits.fz`, so the astropy round-trip tests (RICE/GZIP bit-exact, ≤1-ULP float
dequant) hold unchanged. New tests: placement math from `CRPIX`, overlap trimming,
manifest-v2 round-trip, and the client `(z,x,y)→supertile` lookup (including edge
and degenerate cases).

**Empirical item:** the default `K`. With ~47 KB/q8-tile, `K≈48` keeps even the
worst-case (lossless-fallback ~3×) supertile under ~512 MB (~108 MB typical);
`K≈64` is safe for real noise-dominated data (~192 MB). Lock the default once we
measure real COSMOS-Web tile sizes; exposed as `--supertile-blocks` / a
`[build].supertile_blocks` config key.

---

## 9. Sequencing & relationship to deployment

Supertiles and `fitsgl deploy` are **independent workstreams that meet at the
manifest**, and deploy needs *no change* to handle supertiles: its classifier
already treats every `*.fits.fz` as a cacheable object, so a chunked level is just
more objects (each now safely <512 MB → actually edge-cacheable). Concretely:

- Deploy can ship first for datasets ≤ ~26k² (where no level exceeds 512 MB).
- Supertiles are the **prerequisite for edge-cached delivery of COSMOS-Web-scale
  data** — they are what makes `deploy-design.md` DP4 real for the big levels.
- `deploy-design.md` §4.3 (which discussed the large-`z0` limit) should be updated
  to point here as the resolution, rather than to Cache Reserve (which the research
  showed does **not** rescue >512 MB objects).

Suggested build order: (1) manifest v2 + the client supertile lookup (small, fully
testable, back-compat shim); (2) the emitter + fixed-`K` partitioning for the
single-FITS `GridSource` (solves Problem A end-to-end); (3) `PlacedTilesSource` +
multi-input config + the SP8 guard (solves Problem B); (4) measure real
COSMOS-Web tiles and lock `K`.

---

## 10. Open / empirical items

- **Default `K`** — shipped at **48** (`build_pyramid.DEFAULT_SUPERTILE_BLOCKS`),
  overridable via `[build].supertile_blocks`. 48 stays under the 512 MB cap even in
  the worst (lossless-fallback) case and is ~100 MB on real noise data; it remains
  *provisional* — re-tune once real COSMOS-Web tiles can be measured (the ~47 KB
  figure is from demo/noise data), trading cold-start fetch size against object count.
- **Whether to ever auto-subdivide** an over-budget block (SP6) vs. just erroring —
  defer until/unless real data trips it.
- **Multi-input config ergonomics** — resolved: a band's `input` accepts a path, a
  list, or a glob (`config._resolve_band_inputs`).
