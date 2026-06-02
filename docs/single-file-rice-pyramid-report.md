# Single-file multi-HDU RICE pyramid — implementation gotchas report

**Status:** investigation only, no code changed. Prepared for a build/no-build
decision on moving from the current *one-`.fits.fz`-per-level* layout to a
*single-`.fits.fz`-per-filter, one-HDU-per-level* display pyramid (all levels
`RICE_1`, `quantize_level=8`, `SUBTRACTIVE_DITHER_2`).

Everything below is grounded in (a) the actual code, with `file:line`
citations, and (b) empirical probes against real generated pyramid files and a
synthesized proposed-layout file (astropy 7.2.0 / numpy 2.2.6 — the repo's own
environment). Appendix A has the raw probe output.

---

## TL;DR

| # | Item | Real problem? | One-line verdict |
|---|------|---------------|------------------|
| **1** | **Range-request access pattern / index** | **Yes (new)** | Bundling reintroduces an HDU-walk the *current* per-file layout doesn't have. **Ship a small derived byte-offset index sidecar.** |
| 2 | P vs Q descriptors | Mostly no, for the display pyramid | Client already reads both per-HDU. A file *legitimately mixes* Q (native) + P (small) levels. Real overflow danger is the **lossless** product, not RICE q=8. |
| 3 | Descriptor-table size | No (one-time) | ~3.8 MiB at native, fetched **once** per level and cached — or eliminated entirely by the index. |
| 4 | Tile size / granularity | No | 256² confirmed end-to-end; ~44 KB/tile is right. Caveat: tile grids do **not** nest 2:1 across levels. |
| 5 | NaN-aware downsampling | No | `block_reduce(nanmean)` → NaN only when *all* inputs NaN. Verified. No erosion. |
| 6 | Order of operations | No | Each level is an independent quantization of **raw-float** downsample-from-native. Verified. |
| 7 | NaN / null rendering | No | Shader `isnan()`→transparent; NEAREST filtering (no smear); auto-stretch is finite-only. Verified. |
| **8** | **(not in brief) Subtractive-dither decode** | **Yes (new)** | The TS RICE decoder does **not** reverse `SUBTRACTIVE_DITHER_2`. Sub-noise for display, but a fidelity gap vs astropy. |

The single most important takeaway: **today's per-level-file layout is already
COG-shaped** (one 16 KB header fetch + one descriptor-table fetch + one
range-request per tile, all cached). The proposed bundling *removes* that
property and must *buy it back* with an index. The rest of the items are either
already correct or are build-side parameter changes.

---

## 1. Range-request access pattern, and the index (PRIORITY)

### What the code does today

A tile fetch flows through three cached layers
(`fits-pyramid/src/fpack/`):

1. **One `FpackFile` per level**, memoized in `TileEngine.files`
   (`tile-source.ts:38`, opened once via `fileForLevel`, `:64-77`).
2. **`FpackFile.open()`** (`fpack-file.ts:137-175`) range-fetches the first
   **16 KB** and parses `Primary@0` + exactly **one** BINTABLE at
   `primary.dataStart` (`:148-149`), growing ×4 only on `IncompleteHeaderError`
   (`:168-171`).
3. **`loadTileIndex()`** (`fpack-file.ts:192-240`) range-fetches the *entire*
   descriptor row-table once (`rowBytes * nRows`) and caches it in `this.index`.
4. **`getTile()`** (`fpack-file.ts:249-279`) does O(1) arithmetic
   (`row = tileY*nTilesX + tileX`, `:257`) and fetches just the tile's heap span
   `[heapStart + heapOffset, +nBytes]` (`:272-273`).

Round-trip count, **current layout**:

- **First tile of a never-touched level → 3 range requests**: `open()` (16 KB,
  1 RT), `loadTileIndex()` (1 RT), tile heap (1 RT).
- **Subsequent tile, same level → 1 range request** (`open`/index cached).
- **Cached or in-flight tile → 0** (LRU + de-dup, `tile-source.ts:81-84`).

Because each level is its own file, **there is no HDU walking** — every file's
two headers sit at bytes 0 and 2880, inside the first 16 KB. This is already the
single-range-request-per-tile behavior you want.

### Why bundling is a regression (verified)

A single `[Primary][z0][z1]…[zN]` file has **no central directory**. FITS HDUs
are sequential, and `parseFitsHeader` (`fits-header.ts:123-150`) returns the
*data-unit* start, not the *next-HDU* start. To reach level `z` you must parse
HDU `0..z-1`'s headers and skip each data unit. The skip distance is computable
from each header *alone* (`dataSpan = ceil((NAXIS1*NAXIS2 + PCOUNT)/2880)*2880`;
`PCOUNT` = heap bytes, `NAXIS1*NAXIS2` = descriptor-table bytes — both present in
the header), so you **don't** have to download the multi-MB heaps. **But the
walk is a strict serial dependency chain**: you can't request HDU `k`'s header
until you've parsed HDU `k-1`'s.

Empirically (Appendix A, synthesized 4-level file), the headers are
*interleaved* with the heaps — HDU[2]'s header starts **2.85 MB** into the file,
HDU[3] at 3.57 MB, HDU[4] at 3.76 MB — so a single speculative "fetch the first
N KB" cannot capture them, and HTTP/2 multiplexing cannot parallelize a
dependency chain.

**Important framing correction (from adversarial verification):** the penalty is
a **one-time, per-level cold-start** cost — up to *n_levels* serial RTTs to reach
the deepest level the first time it's opened — **not** a per-tile cost. The
per-tile heap fetch is *still exactly one range request* in both layouts, and
pan/zoom within an already-opened level pays nothing extra (headers + index are
cached). A naive header-walk would even *function correctly*; the index removes
the serial latency, restoring parity with today.

For a COSMOS-Web-scale pyramid this is ~10 levels (see §note below), so without
an index the deepest-level first-touch can stack ~10 serial RTTs **plus** ~10
descriptor-table GETs (~5.3 MB total). An index collapses all of that to **one**
small GET.

### Recommendation: ship a derived byte-offset index sidecar

**Primary: a compact binary sidecar `<stem>.fidx`** next to the `.fits.fz`,
fetched once at `TileEngine.load` / worker `init`, mapping every tile to an
**absolute** file offset so the client does zero FITS parsing at steady state:

```
absOffset(z, i, j) = HDU[z].datLoc + THEAP_z + heapOffset(z, i, j)
```

(`heapOffset` in the FITS descriptor is per-HDU-relative; the index folds in
`datLoc + THEAP`.) Suggested layout — little-endian (matches `DataView` and JS
native order; this is *our* container, not FITS):

```
Header:  magic 'FIDX'(4) | version u16 | recBytes u16 | nLevels u16 | pad u16
         | fitsByteLength u64 | fitsHash(16)
Per-level dir (nLevels × ~36 B):
         levelBase u64 | nTilesX u32 | nTilesY u32 | znaxis1 u32 | znaxis2 u32
         | ztile1 u32 | ztile2 u32 | zblank i32 | zdither0 u32 | comp u8 | pad
Per-tile records (row-major per level), 28 B each:
         absOffset u64 | nbytes u32 | zscale f64 | zzero f64
```

Addressing is pure arithmetic into one `ArrayBuffer`, matching the client's
existing `row = tileY*nTilesX + tileX` convention (`fpack-file.ts:257`):

```
recOff   = levelBase[z] + (tileY*nTilesX[z] + tileX) * recBytes
absOffset = view.getBigUint64(recOff, true)
nbytes    = view.getUint32(recOff + 8, true)
zscale    = view.getFloat64(recOff + 12, true)
zzero     = view.getFloat64(recOff + 20, true)
```

**What the index must carry, and why:**

| Field | Width | Per | Rationale |
|-------|-------|-----|-----------|
| `absOffset` | **u64** | tile | Full pyramid is ~7 GB > 4 GiB; 32-bit overflows. (Decouples the client from the file's internal P/Q choice entirely.) |
| `nbytes` | u32 | tile | Tile ≤ ~48 KB, far under 2 GiB. |
| `zscale`, `zzero` | f64 | tile | Needed for RICE dequant (`decode-rice.ts:33`); genuinely vary per tile. **If you drop the runtime descriptor table, these must move here** or you're back to fetching the table. |
| `zblank` | i32 | **level** | Build writes one `ZBLANK=-2147483648` per HDU; constant per level → hoist out of the per-tile record. |
| `znaxis1/2, ztile1/2, grid` | u32 | level | So the client never parses a FITS header for geometry. |
| `zdither0`, `comp` | u32, u8 | level | Dither seed + `RICE_1`/`GZIP_2` dispatch (see §8). |

**Sizing** (COSMOS-Web native ~90k², 256² tiles, levels z=0..9 ≈ **165,215
tiles total**):

| Record shape | B/rec | Index size |
|--------------|------:|-----------:|
| Minimal `(off64, nbytes32)` | 12 | ~1.98 MB |
| **+ zscale, zzero (zblank per-level)** | **28** | **~4.6 MB** |
| + zscale, zzero, zblank per-tile | 32 | ~5.3 MB |
| same as JSON (flat pairs … object/tile) | — | ~2.8 … ~9.9 MB |

**This index also makes the runtime descriptor tables unnecessary** — `getTile`
skips `loadTileIndex()` and its per-level multi-MB GETs entirely (that's the
whole point; see §3).

**Staying authoritative** (CLAUDE.md: the `.fits.fz` is the source of truth, the
index a convenience):

1. **Derived, never primary.** The producer walks the just-written file's own
   HDUs/descriptors (astropy is already open in `_build_level`,
   `build_pyramid.py:253-301`) and emits the index. Fully regenerable from the
   file.
2. **Self-validating.** The `fitsByteLength` + `fitsHash` (or ETag) header lets
   the client cross-check the object before trusting any offset.
3. **Drift → fallback.** On magic/version/length/hash mismatch, the client falls
   back to parsing FITS headers directly (the existing `FpackFile` path,
   generalized to a header-walk — `parseFitsHeader` already parses at an
   arbitrary offset; `bintable.ts` already handles P and Q). **Correctness is
   never gated on the index.**
4. R2 objects are immutable + ETag-addressed, so drift can only come from a
   botched rebuild — caught by the stamp.

**Placement options & tradeoffs:**

- **(B) Binary sidecar — PRIMARY.** ~4.6 MB, one immutable GET, microsecond
  typed-array parse, O(1) addressing, CDN-friendly. Cost: a second object to
  keep in lockstep (mitigated by the self-validating header + fallback).
- **(C) Embedded leading-extension HDU — FALLBACK.** Same blob shipped as the
  first extension HDU so a single head GET yields it and nothing can drift.
  Cost: the producer must back-patch absolute offsets after the data HDUs are
  written (a solvable fixpoint — index size is known from tile counts up front —
  but real complexity), and the client skips a larger preamble. Choose this if
  you want strictly one object per pyramid.
- **(A) JSON sidecar.** Human-readable; 2.8–9.9 MB; `JSON.parse` allocates
  ~165k entries (tens of ms + GC) on the worker. Keep only as an optional debug
  emission.
- **(D) Fold into `manifest.json`.** **Rejected** — it would balloon the small,
  human-edited, eagerly-loaded convenience manifest (`manifest.ts`) with ~5 MB
  of per-tile offsets. The manifest should at most gain an `index_url` +
  expected length/hash pointer.

> **Note on level count.** The brief says "6-level," which matches the *demo*
> (8096² → 6 levels). A 90k² COSMOS-Web native needs `ceil(log2(90000/256)) = 9`
> downsamples → **z=0..9 (10 levels)** to reach a 1×1 top. Size estimates above
> use the real ~10-level count.

---

## 2. P vs Q heap descriptors

### The exact astropy rule (re-verified in source)

The descriptor format is chosen **per HDU from the *uncompressed* size**, but the
real constraint is the **compressed heap** size — and the two diverge only when
the compression ratio is below 2×.

- `hdu/compressed/compressed.py:432` — `huge_hdu = self.data.nbytes > 2**32`
  (per-HDU, on the uncompressed array). The comment at `:426-431` explicitly
  warns this CFITSIO heuristic fails for inputs whose *compressed* table exceeds
  4 GB.
- `hdu/compressed/header.py:321,323` — `tform1 = "1QI"/"1QB" if huge_hdu else
  "1PI"/"1PB"` (COMPRESSED_DATA); `:352` — same for GZIP_COMPRESSED_DATA.
- The CompImageHDU write path is `_tiled_compression.py:compress_image_data`
  (`:474`); at `:622` it writes offsets via
  `np.cumsum(...)` **into the column dtype** (int32 for a `1PB` column). **There
  is no overflow guard** in this function. The `_makep` guard
  (`column.py:2278-2281`) only fires on a *single row* ≥ 2 GiB and is **not on
  this code path**.
- **Verified silent wrap:** `np.cumsum` of >2 GiB of sizes assigned into a `>i4`
  array yields a negative value with **no exception** (numpy `over='warn'`, and
  assignment into a preallocated int32 array doesn't even warn).

### Is this a real problem for the display pyramid? Mostly no.

For COSMOS-Web native 90k² float32 (computed):

| z | side | uncompressed | descriptor |
|---|------|-------------:|------------|
| 0 | 90000 | 30.2 GiB | **Q (1QB)** |
| 1 | 45000 | 7.5 GiB | **Q (1QB)** |
| 2 | 22500 | 1.9 GiB | P (1PB) |
| 3+ | ≤11250 | <0.5 GiB | P (1PB) |

So a single bundled file **legitimately mixes Q (native levels) and P (small
levels)**. Two consequences:

1. **The client already handles this.** `tformByteWidth` reads `'Q'→16 B
   descriptor64` / `'P'→8 B descriptor32` per column (`bintable.ts:56-67`) and
   `readDescriptor` decodes both (`:119-132`). **The only new requirement** is
   that the multi-HDU walker call `parseBinTableLayout` **per HDU** (re-read
   `TFORM` for each level) and never assume one file-wide format. Add a unit test
   that decodes a tile from a Q HDU and a P HDU in the same synthetic file.
2. **Bundling does not worsen overflow.** Heap offsets stay HDU-relative; the
   absolute file offset is a 64-bit JS `Number` (`heapStart + heapOffset`,
   `fpack-file.ts:272`), exact to 2⁵³ (~9 PB). The >4 GiB absolute offsets in a
   bundled file are safe.

### The real danger (and it's the *lossless* product)

P-overflow needs `compressed heap > 2 GiB` while `uncompressed < 4 GiB`, i.e.
**compression ratio < 2×**.

- **RICE q=8 on real sky data:** ~5.5× (probed 47.6 KB per 256² noise tile),
  ~2.75× margin → safe.
- **⚠️ Correction (from adversarial verification): RICE q=8 is *not*
  unconditionally ≥2×.** astropy falls back to *lossless* GZIP_1 per tile when
  per-tile quantization fails (`_tiled_compression.py:567-576, 624-627`). On
  *smooth, near-noiseless* synthetic gradients the verifier measured sustained
  q=8 heap ratios of **1.63–1.89×** — below the crossover. Real astronomical
  mosaics always carry per-tile noise (so quantization succeeds at ~5.5×), but
  the safety argument must be *"real data is noise-dominated,"* **not** *"RICE
  q=8 is always >2×."*
- **Lossless GZIP_2 float (`build_pyramid.py:263-266`, the current z=0):** ~1.1×.
  A mosaic whose z=0 uncompressed size is in **~2.2–4.0 GiB** gets P descriptors
  (uncompressed < 4 GiB → `huge_hdu` False) yet a >2 GiB compressed heap → **the
  int32 cumsum wraps silently** and the file is written with corrupted, negative
  heap offsets. COSMOS-Web z0 at 30 GiB is safely Q; the exposed case is
  *mid-size lossless mosaics or any near-native lossless product.* Also note
  `GZIP_COMPRESSED_DATA` shares the same int32 cumsum and has identical exposure.

**Recommendation.** For the display pyramid: no change beyond the per-HDU
`TFORM` test. For *any* lossless product this pipeline emits (z=0 today), add a
cheap guard: after writing, the header is already reopened with
`disable_image_compression=True` (`build_pyramid.py:288-289`) — assert that if
`TFORM1`/`TFORM2` contain `'P'`, then `PCOUNT < 2**31`, else raise pointing to Q.
`PCOUNT` is computed independently of the wrapped offsets, so it's reliable. (A
pre-emptive "force Q" has no clean astropy knob and would need a monkeypatch or
splitting the product.)

---

## 3. Descriptor-table size

`loadTileIndex()` fetches `rowBytes * nRows` bytes **once** per level and caches
the parsed result (`fpack-file.ts:198-199, :231`); it is **not** re-fetched on
pan/zoom.

**COSMOS-Web native:** 123,904 tiles × **32 B/row** (`COMPRESSED_DATA` 1PB=8 +
`GZIP_COMPRESSED_DATA` 1PB=8 + `ZSCALE` 1D=8 + `ZZERO` 1D=8) =
**~3.96 MiB** on first native-level touch (the brief's "~2 MB" assumed ~8 B/row;
the RICE float table is 4 columns). With Q descriptors at native, ~5.7 MiB.
Parsing 124k rows of `DataView` reads is a few ms — not a frame-budget concern.

**Is it a problem?** Only as a one-time cold-start cost, and **the index in §1
eliminates it** — if `(absOffset, nbytes, zscale, zzero)` live in the index, the
client never fetches or parses the descriptor table at all. So treat this not as
a separate fix but as a *free consequence* of adopting the index. A standalone
"pre-extract offsets" sidecar (without the rest of the index design) would solve
this too but duplicates authoritative data for a smaller win.

---

## 4. Tile size / fetch granularity

All confirmed:

- **256² is the configured fpack tile shape.** `FPACK_TILE_SIZE = 256`
  (`build_pyramid.py:33`) → `tile_shape=(256, 256)` (`:276`) → `ZTILE1 = ZTILE2 =
  256` in output (probed). Client reads them at `fpack-file.ts:105-106`.
- **Grid + edge tiles correct.** `nTilesX/Y = ceil(znaxis/ztile)`
  (`fpack-file.ts:110-111`), cross-checked against BINTABLE `NAXIS2`
  (`:113-119`); partial edge tiles clamped by `tileDims` (`:243-247`), mirrored
  in the renderer (`tile-manager.ts:71-80`) which rejects a wrong-sized decode
  (`:308`).
- **~44 KB/tile is right.** Probed 47.6 KB per 256² noise tile at q=8 (~5.5×);
  real sky compresses better → realistic ~36–48 KB. A 4K viewport at native res
  is ~135 tiles fanned across parallel range requests off-thread (`worker.ts`),
  with LRU + in-flight de-dup preventing re-fetch. Granularity is appropriate.

**⚠️ Caveat for clean `(level, i, j)` addressing:** levels are independent
`block_reduce(factor=2**z)` reductions, and `block_reduce` **trims** any
non-divisible remainder (`build_pyramid.py:70-72`). Combined with `ceil` tiling,
**tile grids do not nest 2:1 across levels** for arbitrary dimensions (90000 →
45000 → 22500 happens to halve cleanly; 700 → 350 does not). Per-level addressing
against each level's own `fpack_tile_count` (`build_pyramid.py:297`) is correct;
**do not assume parent-child tile containment** for any prefetch/LOD heuristic —
derive parent regions via WCS or `floor(i/2), floor(j/2)` + a bounds check, not as
an identity.

---

## 5. NaN-aware downsampling

`_downsample` (`build_pyramid.py:67-79`) is `block_reduce(data, factor,
func=np.nanmean)`. Each output pixel is the nanmean over a `factor×factor`
native block → **NaN only when *every* input in the block is NaN**, never when
any single input is NaN. The valid-pixel footprint is **not eroded**. Verified
(numpy 2.2.6):

```
2×2 block, 1-of-4 NaN:  [[1,2],[3,nan]] -> [[2.0]]   (mean{1,2,3}; not eroded)
2×2 block, 4-of-4 NaN:  [[nan,nan],[nan,nan]] -> [[nan]]
4×4 -> 2×2:  block with 3/4 NaN keeps the lone finite value; 4/4 -> NaN
```

The all-NaN `RuntimeWarning` is intentionally suppressed
(`build_pyramid.py:76-78`) — silent but correct. **Not a problem.**

*Design note:* the code downsamples **from native by `factor=2**z`** each level,
not by iterating 2× from the prior level (`build_pyramid.py:347-360` feeds the
same native array to every `_LevelTask`). This is *better* for both NaN footprint
(more inclusive) and accuracy (`nanmean(nanmean(...)) ≠` global `nanmean` when
sub-blocks have unequal NaN counts; probed divergence 0.168 on an 8×8→2×2). The
only cost is build-time: every level re-reads the full native float array
(memory/CPU at gigapixel scale). If you ever switch to iterative for performance,
**iterate on raw float, never on quantized readback** (item 6).

---

## 6. Order of operations

Confirmed: the raw float native array is read once (`_read_input`,
`build_pyramid.py:336`; coerced to float at `:233-234`) and passed unchanged to
every `_LevelTask.data` (`:349-360`). `_build_level` then, **per level**:
`level = _downsample(task.data, factor)` (`:259`, raw float) → build
`CompImageHDU(data=level, quantize_level=…)` (`:272-278`). **Each level is an
independent quantization of freshly-downsampled raw float;** already-quantized
data is never re-downsampled, and z>0 never inherits z=0's quantization.
(Today z=0 is lossless `quantize_level=0`, so for z=0 there's no lossy step at
all.) **Not a problem.**

---

## 7. NaN / null rendering

Deliberate and correct end-to-end; **unaffected** by the proposed change (which
actually *simplifies* it onto the single RICE path). Independently verified by me
and by an adversarial check.

- **NaN production agrees on both decode paths.** RICE: `decode-rice.ts:33`
  maps the `ZBLANK` sentinel → JS `NaN`. GZIP_2: `decode-gzip2.ts:53-58` passes
  native IEEE-754 NaN bit patterns through losslessly. Both are unit-tested.
- **Shader discards NaN before the stretch math.** Single-band
  `tile.frag.ts:93-97`: `if (isnan(v)) { outColor = vec4(0,0,0,0); return; }`.
  RGB: per-channel `isnan`, transparent only when all three are NaN (D8,
  `:78-89`). NaN never reaches `scaleChannel`, so it cannot produce garbage
  colors.
- **No NaN smear.** R32F tile textures use **NEAREST** min/mag filtering
  (`gl-util.ts:107-108`; R32F isn't core-filterable), so a NaN texel can't bleed
  into finite neighbors. (Only the RGBA8 colormap LUT uses LINEAR, sampled by the
  already-clamped `[0,1]` stretch output.)
- **Auto-stretch is finite-only.** The *only* data-range computation in the
  library, `percentileRange` (`auto-stretch.ts:38`), gates every sample with
  `Number.isFinite(v)` and returns `null` on no-finite/collapsed range
  (`:41,48`). There is no other raw min/max scan anywhere, and `CursorInfo`
  exposes no raw pixel value, so NaN can't poison the interval or leak to a host.

**Minor notes:** (a) the GLSL `isnan()` branch itself isn't unit-tested (no
headless-GL in vitest) — only the decode→NaN and percentile→finite links are;
(b) `isnan()` can be miscompiled under aggressive fast-math on some mobile GPUs
(the `v != v` idiom is more optimizer-resistant) — low risk on desktop WebGL2;
(c) `scaleChannel` divides by `(hi-lo)`; a host calling `setStretch(x, x)`
directly would render finite pixels as NaN — auto-stretch never sets a collapsed
range, so this is a host-API edge, not a blank-pixel bug.

---

## 8. Additional gotchas not in the brief

### 8.1 ⚠️ The RICE decoder does not reverse `SUBTRACTIVE_DITHER` (new work item)

`decode-rice.ts:33` dequantizes as plain `int*zscale + zzero`. That is **correct
for `NO_DITHER`** — which is what the pipeline writes *today* (it never passes
`quantize_method`, so the probe shows `ZQUANTIZ = NO_DITHER`). The proposed plan
switches to `SUBTRACTIVE_DITHER_2`, whose faithful dequant is
`(int − d_i + 0.5)*zscale + zzero`, where `d_i` is a per-pixel value from the
`ZDITHER0`-seeded fpack RNG. Skipping the dither term leaves a per-pixel,
seed-determined error bounded by ~½ a quantization step ≈ **σ/16**.

- **Impact for display:** sub-noise (σ/16 « the σ-level noise already shown), and
  *within the existing 1σ round-trip tolerance* (`quant_atol`,
  `build_pyramid.py:133-142`) — so it wouldn't even fail the current tests.
- **But:** CLAUDE.md makes "decode correctness gated by astropy fixtures" a core
  principle. To keep that airtight rather than leaning on a loose tolerance,
  implement subtractive-dither reversal (needs the fpack RNG + `ZDITHER0`, which
  is why the index in §1 carries `zdither0` per level). **Decision to make:
  implement dither reversal for fidelity, or accept the documented sub-noise
  residual for a display-only product.**
- Pick `SUBTRACTIVE_DITHER_2` (not `1`): verified that DITHER_2 **preserves
  exact-zero finite pixels** whereas DITHER_1 scatters true zeros into ~0.1-level
  noise. NaN/blank pixels are never dithered under either (ZBLANK-flagged,
  excluded from quantization) — NaN mask round-trips exactly.

### 8.2 Client refactor is non-trivial

`FpackFile` is hard-wired to `Primary + one BINTABLE`: nearly all fields are
single-BINTABLE `readonly` (`fpack-file.ts:69-135`), and `open()` parses exactly
two headers. Supporting a multi-HDU file requires: (i) an HDU-walk loop in
`open()` (reusing `parseFitsHeader`); (ii) promoting `znaxis*/ztile*/nTiles*/
layout/zblank/index` to a **per-level record**; (iii) making
`loadTileIndex/getTile/tileDims` take a `level`; (iv) flipping `TileEngine.files`
(`tile-source.ts:38`) from per-level files to one shared file with per-level
metadata; (v) collapsing `resolveLevelUrl` to one URL. With the §1 index, most of
the walk is bypassed, but the per-level-metadata restructuring is still needed.
**This is the main implementation cost of the move.** (`manifest.ts`/`dataset.ts`
are largely unaffected beyond an `index_url`.)

### 8.3 z=0 lossless guarantee is dropped — a *policy* decision

The module docstring (`build_pyramid.py:1-13`) and CLAUDE.md both promise z=0 is
GZIP_2 **lossless** (a science-distribution product). The all-RICE-q8 plan makes
z=0 lossy. Your stated plan already accepts this (raw science kept as a *separate*
distribution product), but it has code consequences: `_verify_roundtrip`'s
`z==0` branch asserts **exact** equality (`build_pyramid.py:157-162`) and **will
raise** once z=0 is lossy — it must move to the tolerance branch. Also update the
`quant_atol` comments (still say "q=16/σ16"; the 1σ tolerance stays safe at q=8)
and the docstring/CLAUDE.md.

### 8.4 Minor latent fragility

`tformByteWidth` classifies via `includes('Q')`/`includes('P')` on the whole
`TFORM` string (`bintable.ts:57-58`). Fine for the fpack columns here (`1PB`,
`1QI`, `1D`), but a future column whose TFORM contained a stray P/Q would
misclassify. Not a current risk; worth anchoring the regex to the format
position if the table schema ever grows.

### 8.5 The client cannot detect a server-side P-overflow

If a lossless P-descriptor heap ever overflowed int32 (§2), the client would
receive a wrapped/negative `heapOffset` and `getBytes` would fetch wrong bytes
**with no error** (`bintable.ts:126-129` trusts the descriptor blindly). Cheap
insurance: assert `heapOffset ∈ [0, PCOUNT)` when parsing. The §1 index sidesteps
this for the display pyramid (it stores validated u64 absolute offsets), but the
guard matters if lossless single-file products are ever shipped.

---

## Appendix A — empirical probe data

**Synthesized proposed-layout file** (4 levels, `RICE_1`, `quantize_level=8`,
`quantize_method=2`), HDU offsets — note headers interleaved with heaps:

```
HDU[0] PrimaryHDU    hdrLoc=0        datLoc=2880      datSpan=0
HDU[1] CompImageHDU  hdrLoc=2880     datLoc=8640      datSpan=2845440   (z0)
HDU[2] CompImageHDU  hdrLoc=2854080  datLoc=2859840   datSpan=714240    (z1)
HDU[3] CompImageHDU  hdrLoc=3574080  datLoc=3579840   datSpan=181440    (z2)
HDU[4] CompImageHDU  hdrLoc=3761280  datLoc=3767040   datSpan=46080     (z3)
```

Per-HDU header keywords (z0): `ZCMPTYPE=RICE_1`, `ZTILE1=ZTILE2=256`,
`ZBLANK=-2147483648`, `ZQUANTIZ=SUBTRACTIVE_DITHER_2`, `ZDITHER0=5485`
(distinct per level: 5485/7789/8765/77), columns `COMPRESSED_DATA(1PB)`,
`GZIP_COMPRESSED_DATA(1PB)`, `ZSCALE(1D)`, `ZZERO(1D)` → 32 B/row. Heap offsets
are per-HDU-relative (`datLoc + THEAP + heapOffset`).

**Current real file** `demo/public/pyramid/f150w/f150w_z0.fits.fz` (8096²,
GZIP_2 lossless): heap (`PCOUNT`) = 177,955,383 B (~178 MB) and still uses
`1PB` — confirming astropy keys P/Q on *uncompressed* size, not heap size.

**astropy source rule:** `compressed.py:432 huge_hdu = self.data.nbytes > 2**32`;
`header.py:321/323/352` choose `1Q*` vs `1P*`; `_tiled_compression.py:622`
cumsum into the column dtype with no overflow guard (silent int32 wrap verified).

**Compression ratios (probed):** RICE q=8 on noise ~5.5× (47.6 KB/256² tile);
RICE q=8 on smooth gradients as low as 1.63–1.89× (gzip fallback); lossless
GZIP_2 float ~1.1–1.17×.
