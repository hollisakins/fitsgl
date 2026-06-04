# FitsGL v1.0 Roadmap

A planning document for the work between the current state (Phases 1–4) and a
v1.0 release. Scope is locked: six features (below), three delivery tiers. A
seventh capability — **tiled-mosaic rendering** for fields too large to drizzle
whole (e.g. COSMOS) — is planned as **M6, after the v1.0 freeze** (§2.7, §5); its
architecture is still being finalized. This
document inventories what exists, analyzes each feature against the real code,
**records the design decisions taken (with reasoning)**, and proposes a
milestone sequence. Decisions are summarized in the Decisions log and elaborated
in each section; the few items deliberately left open are listed at the end of
that log.

---

## Decisions log

| # | Area | Decision | Reasoning | §  |
|---|---|---|---|---|
| D1 | North-up | **Rotate at the viewport** (no pre-rotated pyramids). | Preserves the project's core goals — no duplicate storage, no pre-render resampling. The rotation transform itself is free (a 2×2 in the vertex stage). | 2.1 |
| D2 | Rotation home | Camera **stays axis-aligned in world/pixel space**; rotation lives in the world→screen (view) transform + the coords module. | All tile-selection math is world-space and stays valid and tested; rotation is a property of the *view*, not of pan/zoom *state*. | 4.1 |
| D3 | Sampling under rotation | **Ship NEAREST for v1.0.** Revisit LINEAR only after seeing rotated output. | Rotation aliasing is cosmetic (values stay correct); avoids speculatively taking on the `OES_texture_float_linear` dependency and its NaN-edge fringe handling. *(Deferred sub-decision — see open items.)* | 2.1 |
| D4 | RA/Dec readout | Compute in JS from the per-level `wcs` dict (TAN + CD matrix, ICRS). | Small, dependency-free, no schema change; the WCS is already in the manifest. | 2.1 |
| D5 | Shader strategy | **One mega-shader, uniform branches.** Carry the RGB-mode slot from M1. asinh uses **fixed softening**. | Matches today's single-program structure, lowest churn; building the RGB slot early stops M4 rewriting the M1 shader. | 2.2, 4.3 |
| D6 | Colormaps | **Bundled built-in palettes**, single-band mode only. API still accepts raw LUT data (built-ins documented). | Zero-config, bounds bundle size; raw-LUT acceptance is free future-proofing for CAMPFIRE. | 2.3 |
| D7 | RGB storage | **Hybrid**: independent single-band pyramids (each renderable alone), grouped by a *dataset manifest*; **strict same pixel-grid + WCS** for compositing; **no in-browser resampling**. | Reuses the existing pipeline unchanged per band; the same-grid rule deletes the hardest part (WCS-driven resampling) and makes the composite a same-UV multi-sample. | 2.4 |
| D8 | RGB channel-missing | **Per-channel-zero** (NaN in a channel contributes 0); pixel transparent only if all three are NaN. | Keeps a pixel visible when only one band is blank; the all-NaN case matches the single-band NaN→transparent rule. | 2.4 |
| D9 | Dataset manifest | New additive manifest listing available bands (short name, filepath, WCS info) + a **hash of canonical WCS-grid params** for trivial match-grouping. No change to the per-pyramid manifest; **no version bump**, but start *checking* version at v1.0. | Lets the channel-picker offer only WCS-matched bands; additive keeps every existing pyramid valid. | 2.4, 4.2 |
| D10 | Overlays | **WebGL marker geometry** (instanced, per-instance style) + **CPU spatial-index hit-testing** (click/hover callbacks) + **one reused DOM popup**. Simple shapes only (points, circles, boxes). | WebGL handles large catalogs without DOM-node slowdown; CPU picking + a single DOM popup give CAMPFIRE per-marker callbacks and rich tooltips without thousands of nodes. | 2.6 |
| D11 | Public API | **Narrow** the public surface + an `/internal` subpath; route `Camera` mutation through methods; tile-selection helpers become internal. | The current `index.ts` over-exports internals that shouldn't carry a v1.0 stability promise. | 4.4 |
| D12 | React wrapper | **Settled + shipped (M5).** `<FitsViewer>` is **controlled by a single `config: ViewerConfig` prop** (diffed by a pure `planConfigUpdate`, routed to the cheapest viewer call) + an **imperative `ref` handle** for the live marker push (`setMarkers`/`add`/`update`/`remove`/`clear`) and one-shot actions (`autoStretch`/`fitToImage`/`getViewer`). Markers are **not** a controlled prop (a 10–20k array would diff every render). The tier is a **pure consumer of the D11 public API**. | Wrapping a settled surface avoids mirroring a churning API into three tiers; one `config` contract matches the host's mental model; pushing markers via the handle fits CAMPFIRE's live, filtered set. | 3.2, 5 |
| D13 | Tiled mosaics | Render a field too large to drizzle whole as **N co-gridded tile-pyramids placed by integer pixel offset** (tiles share tangent point + CD + scale; CRPIX/footprint differ). No reprojection, no sub-pixel sampling; a per-tile **interior clip** resolves the ~1000-px overlap; a **synthesized virtual WCS** drives readout/North-up/markers. | The data already exists as independently-drizzled aligned tiles, so *placement* (not resampling) composites them — reusing the world-space tile-culling and multi-manager machinery. **M6, post-v1.0; architecture still being finalized.** | 2.7, 5 |
| D14 | ViewerConfig band shape | A band is a **list of tile-pyramid manifest URLs** (`tiles[]`, length 1 in the common case), not a single URL — baked into the M5 `ViewerConfig` even though the multi-tile renderer is M6. | Freezes the config shape once: a large field lights up when the M6 renderer lands with **no `ViewerConfig` change**. | 3.1, 5 |

**Deliberately left open** (low-risk, decided on observation/implementation): the
NEAREST→LINEAR move and its method (extension vs in-shader bilinear), pending the
M2 visual check (D3); the exact rounding/canonicalization for the WCS-grid hash,
an M4 implementation detail (D9); the precise controlled-vs-imperative split in
the React wrapper, an M5 detail (D12); the **M6 tiled-mosaic architecture**
(placement / overlap-clip / virtual-WCS details — still being finalized, D13).

---

## 1. Current state inventory

Two packages, plus a verification demo. Everything below is read from the code,
not the phase notes; where the notes diverge from the code it is flagged.

### 1.1 `fitsgl-py/` (Python)

**Public API.** `build_pyramid(input_path, output_dir=None, *, tile_size=256,
quantize_level=16, processes=None) -> Manifest` in `build_pyramid.py`; the
`Manifest`/`LevelInfo` dataclasses and `read_manifest`/`write_manifest` in
`manifest.py`; `generate_synthetic_mosaic(...) -> (image, header, catalog)` in
`synthetic.py`; a CLI in `__main__.py` (`python -m fitsgl`, flags `-o`,
`--tile-size`, `--quantize-level`, `--processes`, `--synthetic`).

**Key abstractions.** `_LevelTask` (a picklable per-level work unit) run through
a `multiprocessing.Pool` (one process per level; inline for a single level).
Geometry helpers: `n_levels`, `_downsample` (`block_reduce` + `np.nanmean`),
`_scale_wcs` (CD/CDELT × 2^z, half-pixel CRPIX correction), `_pixel_scale_arcsec`
(mean of both axes). `StopAndAsk` gates ambiguous inputs.

**Test coverage.** Strong on correctness: level count, per-level ZCMPTYPE, tile
size, **z=0 bit-exact lossless** round-trip, z>0 within tolerance, per-level WCS
sky-projection (<1e-3″), NaN-mask survival, manifest↔file agreement, CLI run;
plus `StopAndAsk` paths. Untested: real rotated WCS at scale, very large inputs.

**Limitations relevant to v1.0.** (a) SIP/TPV distortion is **rejected**, not
handled — consistent with the v1.0 deferral. (b) One 2-D image HDU per file;
multi-extension is rejected. (c) The WCS is written into each level header via
`level_wcs.to_header(relax=True)` and copied verbatim into the manifest as a
flat dict (`{k: level_header[k]}`). This is the only WCS the client ever sees.
(d) `pixel_scale_arcsec` is a **scalar mean** of the two axes — it discards the
CD matrix's rotation and any anisotropy, which features 1 and 6 will need from
the `wcs` dict, not this field. (e) The synthetic generator returns a
`catalog` DataFrame `[x, y, ra, dec, flux]`, but `__main__._write_synthetic`
**discards it** — there is no catalog output path anywhere yet.

The notes (`notes/phase1.md`) accurately describe the code, including the two
deliberate deviations from the original brief (q=0 for lossless GZIP_2; the
half-pixel CRPIX correction).

### 1.2 `fitsgl-core/` (TypeScript)

**Public API** (`src/index.ts`, the single entry point): `riceDecompress`,
`BitReader`; `loadManifest`, `validateManifest`, `resolveLevelUrl`, types
`Manifest`/`LevelInfo`; `TilePyramid`, `TileEngine` + option types; `FpackFile`,
`httpRangeFetch`, `decodeRiceTile`, `decodeGzip2Tile`, `gunzip`, `LRUCache`;
`attachTileWorker` + worker protocol types; `FitsViewer`, `Camera` + option
types; and the tile-selection helpers `targetLevel`, `visibleTiles`,
`buildLevelGeoms`, `TILE_SIZE` with their types. **This is a very wide surface
for a v1.0 stability commitment** (narrowed per D11; see §4.4).

**Key abstractions.**
- `TilePyramid` (façade) → `TileEngine` (manifest + lazy `FpackFile`/level +
  decoded-`Float32Array` LRU + in-flight dedup), optionally hosted in a Web
  Worker (`worker.ts`). `getTile(level, x, y) -> Promise<Float32Array>`.
- `FitsViewer` (`renderer/viewer.ts`): owns one WebGL2 context, one shader
  program, a `Camera`, a `TileManager`. On-demand render loop. Public methods:
  `setStretch(min, max)`, `setCenter(x, y)`, `setZoom(zoom)`, `fitToImage()`,
  `destroy()`; options `textureBudget`, `hiDpiLevels`, `onFrame`.
- `Camera` (`renderer/camera.ts`): pure affine pixel-space math, **no
  rotation**. Mutable public fields `centerX`, `centerY`, `zoom`.
- `TileManager` (`renderer/tile-manager.ts`): GPU R32F textures keyed by
  `"level/x/y"` — **single-stream, no channel/band dimension**.
- Shaders (`renderer/shaders/`): one program. Fragment shader hardcodes a
  **linear stretch → grayscale** output and NaN → transparent.

**Test coverage.** Excellent on the decode path (49 RICE fixtures from astropy,
decode exact; GZIP_2 bit-exact; partial-edge tiles; worker lifecycle; range 206
enforcement) and on the pure renderer math (camera inverses, anchored zoom,
`targetLevel`, `visibleTiles`, eviction policy). **Not tested:** anything
requiring a real GL context or canvas (the GL classes run only via their pure
helpers); there is **no WCS/coordinate code at all** on the TS side.

**Limitations relevant to v1.0.** (a) NEAREST filtering only — R32F is not
filterable in core WebGL2; LINEAR needs `OES_texture_float_linear`. v1.0 ships
NEAREST (D3). (b) The vertex shader's `u_rect` expresses only an **axis-aligned
NDC rectangle** (two corners via `mix`) — it cannot draw a rotated quad; North-up
(D1) generalizes this. (c) Single band, single stream, one draw call per tile.
(d) The worker is referenced as a separate module URL
(`new URL('../worker.js', import.meta.url)`), which matters for bundling the
vanilla embed (§3.3). (e) The library builds with `tsc` only — **no bundler** in
the package today.

### 1.3 `demo/` (Vite)

Vanilla TS verification app. Loads a manifest, drives `TilePyramid` **inline**
(no worker, to count bytes), wires `FitsViewer` + a HUD. Notable reusable
asset: `demo/vite.config.ts` ships a byte-accurate **HTTP Range (206)
middleware** and an ETag/`no-cache` revalidation emulation — directly relevant
to the SSG (§3.4, §6). `controls.ts` has a working percentile auto-stretch
(`percentileRange`) worth promoting into the core.

---

## 2. Per-feature architectural analysis

### 2.1 RA/Dec display + North-up rendering (ICRS)

**What it is.** The viewer shows the cursor's sky coordinate (RA/Dec, ICRS,
sexagesimal + degrees) live, and renders the image **North-up / East-left**
regardless of the underlying WCS rotation — so a mosaic whose CD matrix carries
a 30° roll appears upright, and panning/zooming preserve that orientation.
Acceptance: load a deliberately-rotated synthetic WCS; assert (1) the rendered
image is rotated to North-up within <0.1°, (2) a known star's pixel projects to
its catalog RA/Dec within sub-pixel tolerance, (3) the readout matches astropy's
`pixel_to_world` at several cursor positions.

**What changes architecturally.** New module `fitsgl-core/src/wcs/` (a TAN
forward/inverse projection + CD-matrix pixel↔world, ICRS only) — there is no
coordinate code today. Per D2, the `Camera` is **unchanged**; the North-up
rotation is composed into the world→screen transform in `viewer.drawTile`, and
the vertex shader's `u_rect` is generalized from an axis-aligned rectangle to a
full quad transform — `renderer/shaders/tile.vert.ts` and `viewer.ts` change.
`FitsViewer` gains a cursor→sky hook (likely a new `onCursor`). `fitsgl`
needs no change (the per-level `wcs` dict already carries CD + CRPIX/CRVAL).

**Manifest schema impact.** None — the `wcs` dict is already present per level.
The client reads the **CD matrix** from `wcs` (D4), not the scalar
`pixel_scale_arcsec`, which has dropped the rotation.

**Design questions & decisions.**

| Question | Decision |
|---|---|
| Where does North-up rotation happen? | **D1: rotate at the viewport.** |
| Where does rotation live in code? | **D2: a view-transform layer over an axis-aligned camera.** |
| Sampling under rotation | **D3: NEAREST for v1.0**, revisit on observation. |
| Coordinate readout source | **D4: JS TAN math from `wcs`.** |

**Consequence to note.** Under rotation, the on-screen viewport maps to a
*rotated* rectangle in world space; `visibleTiles` will intersect its
axis-aligned bounding box and slightly **over-select tiles at the corners**
(a few off-screen fetches). Expected, mild, not a correctness issue.

**Estimated complexity: L.** The TAN math is small and testable against astropy
fixtures; the cost is the view-transform/vertex-shader generalization and
ensuring overlays (M3) inherit the same rotation. NEAREST (D3) removes the
linear-filtering work from v1.0 scope.

**Dependencies.** The `wcs/` module is a prerequisite for catalog overlays
(§2.6) and the RGB grid-match check (§2.4). Independent of stretches/colormaps.

### 2.2 Non-linear stretches (asinh, log)

**What it is.** A user-selectable stretch function — linear (existing), asinh,
log — applied to the same raw float textures, with the existing min/max as the
input domain. Acceptance: switching stretch changes only the transfer curve, not
the data fetched; asinh/log match a reference transfer function within float
precision; NaN stays transparent.

**What changes architecturally.** Only the shader and a viewer setter:
`renderer/shaders/tile.frag.ts` and a `setStretch`-adjacent method (e.g.
`setStretchMode`). The raw values are already in the textures (the design
explicitly never bakes stretch into data), so this is genuinely a shader change.

**Manifest schema impact.** None. (The SSG may record a *default* stretch in its
site config — a delivery convenience, not a manifest change.)

**Design questions & decisions.**

| Question | Decision |
|---|---|
| Shader strategy | **D5: one shader, uniform branch** (decided once for stretch/colormap/RGB; see §4.3). |
| asinh parameterization | **D5: fixed softening.** |

**Estimated complexity: S.** A shader branch plus a uniform and a setter, with
golden-value tests. Do it as part of the M1 shader so it isn't redone.

### 2.3 Custom colormaps (single-band)

**What it is.** For single-band view, a user-selectable palette (viridis, magma,
gray, etc.) mapping the post-stretch [0,1] scalar to RGB. Acceptance: selecting
a colormap recolors without refetch; NaN stays transparent; the palette matches
a reference LUT.

**What changes architecturally.** Fragment shader samples a **1-D colormap LUT
texture** instead of writing gray; `FitsViewer` gains `setColormap(name | data)`
and uploads the LUT (a second sampler / texture unit). `gl-util.ts` gains a
LUT-texture helper. A small built-in palette table ships in the library.

**Manifest schema impact.** None.

**Design questions & decisions.**

| Question | Decision |
|---|---|
| LUT delivery | **D6: bundled built-ins**; the API still accepts raw LUT data (built-ins documented for v1.0). |
| Colormap + RGB coexistence | **D6: single-band only.** |

**Estimated complexity: S.** A LUT texture, a sampler, a setter. Pairs naturally
with §2.2 in M1.

### 2.4 RGB compositing

**What it is.** Compose three single-band pyramids — chosen as R/G/B from a set
of available bands — into one color image, each channel with its own stretch and
min/max. The three bands must share an identical pixel grid + WCS (the picker
enforces this; see D9). Acceptance: pick three WCS-matched bands; they render as
a registered color image; per-channel stretch is independent; pan/zoom keeps
channels registered; a NaN in one channel contributes 0 to that channel and a
pixel goes transparent only when all three are NaN (D8).

**What changes architecturally.** Bounded by D7 (no in-browser resampling), the
work concentrates in the renderer rather than the data layer:
- **`fitsgl`**: no change to per-band generation. New: a **dataset-manifest
  writer** that lists available bands and a canonical WCS-grid hash (D9).
- **Data layer**: each band is an existing `TilePyramid`/`TileEngine`,
  **instantiated three times** — almost no engine change.
- **`TileManager`**: textures gain a band dimension (`"band/level/x/y"`);
  `acquire`/`request`/eviction become band-aware; GPU budget effectively triples.
- **Shader**: the RGB mode of the D5 mega-shader samples three textures, applies
  three stretches, outputs RGB. Same UV across bands (guaranteed by D7), so no
  resampling — a trivial multi-sample.
- **Auto-stretch**: per-channel percentile (extend `percentileRange`).
- **Partial-load**: handle "R resident, G/B still loading" (fall back per band,
  or hold composite until all three present) — a small policy in the draw loop.

**Manifest schema impact.** **Additive (D9).** The per-pyramid manifest is
unchanged. A new optional **dataset manifest** sits above it, listing bands with
`{shortName, path, wcs, gridHash}`. No `version` bump; old single-band pyramids
keep working. (`validateManifest` should begin *checking* version at v1.0 so any
future break is detectable — §4.2.)

**Design questions & decisions.**

| Question | Decision |
|---|---|
| Storage / pyramid model | **D7: hybrid** — independent single-band pyramids, grouped by a dataset manifest. |
| Registration | **D7: require identical grid+WCS; in-shader resampling out of scope.** |
| Band selection UX | Pick one channel, then the picker offers only WCS-matched bands (gridHash, D9). |
| Channel-missing policy | **D8: per-channel zero; transparent only if all three NaN.** |

**Estimated complexity: XL, but de-risked.** D7 deletes the resampling problem
and keeps the data layer near-unchanged (three existing instances). The
remaining XL drivers are the band-aware `TileManager`, the composite shader mode,
per-channel stretch, the dataset manifest, and the 3× GPU/bandwidth budget —
substantial but bounded.

**Dependencies.** Builds on the M1 shader (the RGB mode slot) and the M2 `wcs/`
module (the grid-match hash). Lands after both.

### 2.5 Three-tier delivery (React / vanilla embed / SSG)

Covered in depth in §3 (primarily an architecture question, not a per-feature
one). Complexity: React wrapper **M**, vanilla embed **M**, SSG **M**. Manifest
impact: none beyond what features 1–4 force; the SSG may add a small *site
config* (default stretch/colormap/overlay file) orthogonal to the pyramid
manifest.

### 2.6 Flexible catalog/region overlays

**What it is.** Render point/region markers positioned by RA/Dec (or pixel) over
the image, staying registered under pan/zoom and North-up rotation. Simple
enough that the SSG can show a catalog from a CSV; flexible enough that a React
host (CAMPFIRE) can drive markers programmatically with per-marker styling and
click/hover callbacks. Acceptance: markers land on the right sky position at all
zooms and under rotation; the SSG path renders a CSV of RA/Dec; the React path
can add/update/remove markers, set per-marker properties, and receive click and
hover events.

**What changes architecturally.** Depends on the M2 `wcs/` module for sky→pixel.
A new overlay subsystem in the renderer per D10: **WebGL marker geometry**
(instanced quads/points, per-instance color/size/shape attributes) sharing the
viewer's transform so markers rotate with North-up for free; a **CPU
spatial-index** (grid/quadtree) for click/hover hit-testing that fires callbacks
with marker data; and **one reused DOM element** for the active tooltip/popup
(rich content without thousands of nodes). Plus a `fitsgl` catalog export
path (the synthetic catalog is currently discarded).

**Manifest schema impact.** None to the pyramid manifest. A **new
overlay/catalog format** is needed (CSV/JSON of RA/Dec + properties) — net-new,
versioned alongside the dataset manifest.

**Design questions & decisions.**

| Question | Decision |
|---|---|
| Render layer | **D10: WebGL geometry + CPU hit-test + one DOM popup.** |
| Coordinate input | Sky (RA/Dec) primary; pixel-space supported as a subset. |
| Hit-testing | Click/hover callbacks (CAMPFIRE needs them). |
| Region shapes | **Simple shapes only** (points, circles, boxes); polygons deferred. |

**Estimated complexity: L.** The hybrid render path (instanced WebGL + spatial
index + DOM popup) is more than a single layer, and it must respect M2 rotation.

**Dependencies.** M2 (sky transforms + rotation).

### 2.7 Tiled-mosaic rendering (M6, post-v1.0)

**What it is.** Render a field too large to drizzle as a single image — e.g.
COSMOS, ~90k×90k at 0.03″/px, beyond the drizzle algorithm on a standard machine
— directly from the **tiles that already exist on disk**, without ever
materializing the full mosaic. The producer drizzles the field as ~20 overlapping
tiles that **share one tangent point, CD matrix, and pixel scale**, differing only
in CRPIX and footprint: integer-offset windows of one virtual grid, with **no
sub-pixel offset by construction** (the producer drizzles onto a single predefined
global grid). The host lists the tile manifests in `ViewerConfig`; the viewer
composites them into one seamless, pannable image under a single sky coordinate
system. Acceptance: load N aligned tiles; they render seam-free across the
overlap; RA/Dec, North-up, and markers operate against one virtual WCS; only the
tiles intersecting the viewport fetch detail.

**What changes architecturally.** A generalization of the existing world-space
machinery, not a reprojection engine (D13):
- **`TileManager` gains a world offset.** Tile culling (`visibleTiles`) and draw
  are already world-space; placement = subtract the offset from the cull bounds,
  add it back at draw. The viewer already holds an *array* of managers (the 3 RGB
  bands), so "N placed managers" extends "3 RGB managers."
- **A relaxed co-grid check.** Today `gridsMatch` requires *identical* WCS;
  mosaicking needs "same CTYPE/CRVAL/CD/scale/tiling, CRPIX & footprint may differ
  → derive the integer offset."
- **A synthesized virtual WCS** (shared CRVAL+CD, a chosen virtual CRPIX) so the
  readout/North-up/markers use one frame; one shared CD ⇒ one North-up matrix.
- **Overlap handling** via a per-tile **interior clip rectangle** (trim the
  ~1000-px overlap / noisy drizzle edge so tiles tile the plane exactly once).
- **Virtual extent** replaces the single `nativeW/H` for zoom limits / fit-to-image
  / marker hit-test bounds. RGB composes on top (N tiles × 3 co-gridded bands).

**Manifest schema impact.** None to the per-pyramid manifest — each tile is an
ordinary pyramid. The mosaic is expressed in `ViewerConfig` as a band's `tiles`
list (D14); the geometry is **derived from each tile's self-describing WCS**, not
restated by the host. (A serialized "mosaic manifest" — the `dataset.json`
analogue — may be added for the SSG path.)

**Design questions & decisions.**

| Question | Decision |
|---|---|
| Composite model | **D13: placed sub-pyramids on a shared grid** (integer offset, no resampling). |
| Config shape | **D14: a band is a `tiles[]` list** (length 1 normally), baked into M5. |
| Overlap | Per-tile interior clip; the ~1000-px overlap is trimmed, not blended. |
| Sub-pixel offsets | Out of scope — producers drizzle onto one global grid, so offsets are integer. |

**Alternative (zero-renderer-change fallback).** `fitsgl` could **stream the
N tiles into one field pyramid** at build time — *re-tiling, not re-drizzling*, so
it sidesteps the whole-field drizzle bottleneck (at z=0 the aligned pixels are
cropped/copied). It puts a large field on screen with today's renderer, at the
cost of one big artifact and a build step. Inferior to the renderer-native path
for a producer whose data already lives as independently-buildable per-tile
pyramids, but a viable stopgap before M6.

**Estimated complexity: L.** Bounded — every piece generalizes existing
world-space code — but it touches the camera-extent, tile-culling, grid-match,
and overlay-WCS paths at once.

**Dependencies.** M2 (sky transforms — the virtual WCS) and M4 (the multi-manager
/ grid-match machinery it extends). Lands after the v1.0 freeze.

---

## 3. Three-tier delivery architecture

The three tiers are **one engine, three entry points** — not three products.

### 3.1 The shared core

The core is the existing `@fitsgl/core` package: `TilePyramid` (data) +
`FitsViewer` (render) + `manifest` + decoders + the (new) `wcs` module. All
v1.0 features (§2.1–2.4, §2.6) land **in the core**, expressed as imperative
methods/options on `FitsViewer`/`TilePyramid`. The single most important
invariant: **a feature is "done" only when it is a core capability**; the tiers
must add no behavior of their own, only adapt the interface.

This argues for a single high-level `ViewerConfig` type that the core accepts and
**all three tiers consume**, so a new feature is added in exactly one type and is
automatically reachable from every tier. Its shape (settled in M5): a **list of
bands** — each band a short name and a `tiles` list of pyramid-manifest URLs
(length 1 for an ordinary image, N for an M6 mosaic, D14) — plus the view state:
which band(s) to show (single, or three as R/G/B), stretch mode + min/max,
colormap, North-up on/off, and an overlay source. Markers are **not** a static config field for the React path: the
M3 push API (`setMarkers`/`setMarkerHandlers`, sky-coordinate input, an opaque
per-marker `data` payload, click/hover callbacks) lets a host like CAMPFIRE own
the catalog DB and push the filtered set live; the SSG's CSV + built-in popup is
the convenience layer on the same core. The D11 narrowing must keep that push API
in the public surface.

### 3.2 React wrapper

**Shipped** as the `@fitsgl/core/react` subpath: a `<FitsViewer>` component that
owns a `<canvas>`, loads the config + constructs a core `FitsViewer` in an effect,
and `destroy()`s the viewer **and every band pyramid** (which the core does not
own) on unmount. It imports **only the frozen public API** — building the tier on
that surface is itself a check that D11 is sufficient.

The controlled/imperative boundary (D12, settled):

- **Controlled** by one `config: ViewerConfig` prop — the single high-level
  contract every tier shares. A pure `planConfigUpdate(prev, next)` (unit-tested,
  no GL/DOM) diffs the incoming config and routes each change to the cheapest
  viewer call: a **band-URL/name change reloads + rebuilds**; `view` →
  `setSource`; `colormap`/`stretch`/`northUp` → the matching live setter. An
  omitted `stretch` auto-stretches, driven off the first drawn frame (the core's
  `autoStretch` is a no-op until then). `northUp` omitted = uncontrolled (the
  viewer keeps its WCS-derived default).
- **Imperative** via a `ref` handle (`FitsViewerHandle`) for the high-frequency
  live path CAMPFIRE drives — `setMarkers`/`addMarkers`/`updateMarker`/
  `removeMarker`/`clearMarkers` — plus one-shot actions (`autoStretch`,
  `fitToImage`, `setCenter`/`setZoom`) and `getViewer()`/`getPyramids()` escape
  hatches. Markers are **not** a controlled prop (a 10–20k-element array would
  diff on every render; pushing through the handle does not).
- **Callbacks** mirror the core's mutability: `onFrame`/`onCursor` are fixed at
  construction (stable trampolines read the latest closure from a ref); the three
  marker handlers hot-swap via `setMarkerHandlers` whenever their presence
  changes. `onReady(handle)` fires once the viewer exists (and after each reload);
  `onError` surfaces load/WebGL failures.

### 3.3 Vanilla embed

A bundled single artifact exposing a global init, e.g.
`FitsGL.mount(element, config)`. Two real problems the current code creates:
1. **No bundler today** — the package builds with `tsc`. The embed needs a
   bundling step (esbuild/rollup/Vite lib mode) producing an IIFE/UMD.
2. **The worker** is referenced as a separate module file
   (`new URL('../worker.js', import.meta.url)`). A true single-`<script>` embed
   must either **inline the worker as a blob URL** or accept shipping a second
   file. Inlining keeps it one tag but enlarges the bundle (a §6 risk because the
   SSG embeds this).

### 3.4 SSG (FITSMap replacement)

A Python CLI (extend `fitsgl` or a sibling, e.g. `fitsgl-build-site`) that:
(1) runs the existing pyramid build(s), (2) copies a **vendored copy of the
vanilla embed bundle** + an HTML template into the output dir, (3) templates in
the manifest/dataset-manifest URL(s), default stretch/colormap, and an optional
overlay/catalog file, (4) writes the catalog the generator already computes.
Output is a self-contained directory deployable to any static host **that
supports HTTP Range** (the `demo/vite.config.ts` middleware documents exactly
what's required; most static hosts/CDNs do, but the SSG docs must state it). The
vendored bundle must be a build artifact shipped with the Python package, with a
pinned version (§3.5).

### 3.5 What goes wrong if they diverge

The failure mode is a feature reachable from one tier but not another: a new
`FitsViewer` option added but not mapped to a React prop, not accepted by the
embed's `mount(config)`, or not templated by the SSG. Mitigations: (a) the single
`ViewerConfig` type as the one place features are declared; (b) the React props
type and the embed init type both **derive** from it rather than restating it;
(c) a conformance test that every `ViewerConfig` key is exercised by each tier;
(d) the SSG **pins the embed bundle version** it vendors and that pin is part of
release — otherwise the SSG silently ships an old engine.

---

## 4. Cross-cutting concerns

### 4.1 Coordinate transforms

Spaces in play: **level-pixel** (per-z), **native-pixel / world** (the camera's
space), **sky / RA-Dec**, **screen**, and — once North-up lands — the rotation
folded into the world→screen step. There is **no canonical conversion code
today**; the camera knows only world↔screen. A dedicated module
(`fitsgl-core/src/wcs/` or `coords/`) owns world↔sky (TAN, CD matrix, ICRS) and
the North-up rotation, and is the single source every consumer (RA/Dec readout,
overlays, North-up render) calls. **Building it before overlays is a sequencing
constraint** (M2 before M3). Per **D2**, the rotation is a view-transform layer:
the `Camera` stays axis-aligned in world space (so `worldBounds`/`visibleTiles`
and their tests are untouched), and rotation is applied in `viewer.drawTile` and
the coords module. The cost is keeping the two transforms consistent, paid once
in the viewer.

### 4.2 Manifest schema versioning

Current schema is `version: 1`; the TS `validateManifest` defaults version to 1
and **does not enforce or reject** unknown fields (lenient, additive-friendly).
Features 1–3 and 6 need **no** schema change. Feature 4 (RGB) is settled
**additively** (D7/D9): the per-pyramid manifest is untouched and a new dataset
manifest groups bands above it — **no `version` bump, no migration**, every
existing pyramid stays valid. The one hardening: `validateManifest` should begin
**checking** the version at v1.0 so a future breaking change is detectable rather
than silently mis-parsed.

### 4.3 Shader management

Stretches (×3), colormaps, and single-band vs RGB combine combinatorially. Per
**D5**, v1.0 uses **one mega-shader with uniform branches** (`u_stretchMode`,
colormap-on, `u_mode` for single-band vs RGB) — matching today's single-program
structure, the lowest-churn path, and cheap at tile fill rates. The RGB mode slot
is built in M1 even though RGB ships in M4, so the shader isn't rewritten.
Specialized programs / GLSL templating remain the documented fallback only if the
branch count later proves unwieldy.

### 4.4 Public API stability

`src/index.ts` currently over-exports internals (`FpackFile`, `BitReader`,
`parseFitsHeader`, `parseBinTableLayout`, `TileManager`, `selectEvictions`,
`readDescriptor`, …). Per **D11**, before v1.0: (a) split into a **narrow public
surface** (`TilePyramid`, `FitsViewer`, `loadManifest`, the config/option types,
the new WCS/coords + overlay API) and an explicit `/internal` subpath for the
rest; (b) **freeze `Camera`'s mutable fields** (`centerX`/`centerY`/`zoom`) by
routing mutation through methods — they are not a contract today; (c) move the
tile-selection helpers to internal (the demo can import them from `/internal`).
`FitsViewerOptions`/`ViewerFrameInfo`/`Manifest` are reasonable to commit to.

### 4.5 Documentation

Before v1.0 ships: (1) a **quick-start per tier** (React, embed, SSG); (2) an
**API reference** for the narrow public surface; (3) a **manifest + dataset +
catalog schema spec** (versioned); (4) an **SSG hosting guide** including the
HTTP-Range requirement; (5) an **examples gallery** (single-band, RGB, overlays);
(6) a short **architecture doc** mapping the three tiers to the shared core.

---

## 5. Proposed milestone sequence

Sequenced so each milestone is independently deployable and each unlocks the
next. T-shirt totals per milestone; no dates.

### M1 — Shader engine: stretches + colormaps (total ~S–M)
*Features:* asinh/log stretch (§2.2), colormaps (§2.3). *Why grouped:* both are
pure shader work and implement the D5 mega-shader — **including the RGB mode slot
now** so M4 doesn't rewrite it. *Deployable:* a richer single-band viewer (and
demo), no schema change — usable immediately by an external user and CAMPFIRE via
the existing core. *Depends on:* nothing.

### M2 — Sky coordinates + North-up (total ~L)
*Features:* the `wcs`/`coords` module, RA/Dec readout, North-up rendering (§2.1).
*Why grouped:* RA/Dec and North-up share the WCS module and the view-transform
rotation work (D2). *Settle at start:* D2 is fixed, so the work is the coords
module + view/vertex-shader rotation. *Ships NEAREST* (D3) — the linear-filtering
question is revisited only if rotated output looks poor. *Deployable:* an
astronomically-correct single-band viewer. *Depends on:* M1's shader structure
(rotation touches the same vertex path).

### M3 — Overlays (total ~L)
*Features:* catalog/region overlays (§2.6, per D10) + a catalog export from
`fitsgl`. *Why grouped:* overlays are the first consumer of M2's sky
transforms and inherit M2's rotation. *Deployable:* viewer with markers; the
SSG-grade "CSV of RA/Dec" path and a programmatic add/update/remove + click/hover
API for React. *Depends on:* M2 (sky transforms, rotation).

### M4 — RGB compositing (total ~XL, de-risked)
*Features:* RGB (§2.4, per D7–D9) — the dataset manifest, three-instance data
layer, band-aware `TileManager`, the composite shader mode (M1 slot), per-channel
stretch. *Why here:* it builds on M1's shader and M2's WCS (the grid-match hash),
and it is the band-grouping schema everything downstream consumes. *Deployable:*
color images. *Depends on:* M1, M2.

### M5 — Delivery tiers + API freeze + docs (total ~L)
*Features:* React wrapper, vanilla embed bundle, SSG (§2.5, §3); the D11 public-
API narrowing; §4.5 docs. *Why last:* the three tiers wrap a **settled** feature
surface so the shared `ViewerConfig` doesn't churn after it is mirrored into three
places. *Deployable:* all three tiers, the v1.0 stability commitment. *Depends
on:* M1–M4.

*Progress:* the **`ViewerConfig` contract** (D14), the **`autoStretch` promotion**
and **D11 API narrowing** (+ `/internal` subpath), and the **React tier**
(`@fitsgl/core/react`, D12) have landed. Remaining: the **vanilla embed** and
**SSG** tiers (both need bundler infra not yet present — `tsc`-only today), and the
§4.5 architecture/usage docs.

**Schema-freeze checkpoint.** The two net-new schemas — the RGB **dataset
manifest** (M4) and the **overlay/catalog format** (M3) — must be finalized by the
end of M4, because M5's SSG and React wrapper consume them. M5 only wraps; it
does not introduce schema.

**Sequencing note / tradeoff.** The React wrapper is the tier CAMPFIRE wants
soonest. It *can* be pulled forward (after M2) at the cost of API churn as M3/M4
land — acceptable if integration pressure is high. The vanilla embed and SSG stay
in M5 because they vendor a frozen bundle (D12).

**M5 design notes (from the CAMPFIRE design review).**
- **Grid policy resolved.** Same-field bands share a pixel grid in practice
  (photometry requires it), so band-switching and RGB are the same-grid case the
  renderer already handles; the only multi-pyramid case is large-field *tiling*
  (M6), which is integer *placement*, not in-viewer reprojection.
- **`ViewerConfig` bakes in the `tiles[]` band shape now** (D14) so an M6 mosaic
  needs no config change — model a band as a (usually length-1) list of tile
  manifests from the start, even though the renderer initially handles only the
  one-tile case.
- **Markers are already CAMPFIRE-shaped.** The M3 push API (`setMarkers`/
  `setMarkerHandlers`, sky input, an opaque per-marker `data` payload, click/hover
  callbacks) already lets a host own the catalog DB and push the filtered set live
  (10–20k markers is well within the instanced-WebGL + CPU-index budget). M5's job
  is to surface it through the React imperative handle and **keep it public through
  the D11 narrowing** — not to add marker behavior.
- **Move URL→`RenderSource` orchestration into the library.** Building a source
  from a manifest/dataset URL currently lives in the demo; the library must own it
  so a `ViewerConfig` is consumable by URL (not by pre-built `TilePyramid`
  objects) across all three tiers.

### M6 — Tiled-mosaic rendering (post-v1.0, total ~L)
*Feature:* render large fields from aligned on-disk tiles without a whole-field
drizzle (§2.7, per D13/D14). *Why after v1.0:* it extends M4's multi-manager and
M2's WCS machinery but is **new scope beyond the locked six features**, and the
architecture is still being finalized. Because the M5 `ViewerConfig` already
carries the `tiles[]` shape (D14), it lands with **no config-contract change** —
only renderer work (world-offset managers, the relaxed co-grid check, the virtual
WCS, the overlap clip). *Deployable:* COSMOS-scale fields in the viewer.
*Depends on:* M2, M4; config shape frozen in M5.

---

## 6. Risks and unknowns

- **RGB browser performance.** Three R32F streams = 3× fetch/decode/upload and
  3× GPU memory; a large viewport already pushes the texture budget. Compositing
  three samplers per fragment is cheap, but the bandwidth and memory are not.
  Unknown until measured on a real 3-band field at full-window size. (D7 removes
  resampling cost but not this.)
- **Vanilla embed bundle size.** The SSG is only pleasant if the embed is small,
  but it includes the RICE decoder, WCS math, shaders, overlay code, and (if
  inlined) the worker. Inlining the worker for a single-tag embed roughly doubles
  the JS. No budget measured yet; set one early.
- **Coordinate-transform correctness.** ICRS + TAN narrows the surface, but the
  client TAN math must match astropy across the field. Edge cases: fields near the
  pole, RA wrap at 0/360°, and the half-pixel WCS convention already in
  `_scale_wcs` (the client must use the *same* pixel-center convention or readouts
  drift by half a pixel). Test against astropy fixtures, not self-consistency.
- **North-up sampling quality.** Viewport rotation + NEAREST = visible
  stair-stepping on diagonal edges. v1.0 accepts this (D3); if it reads poorly,
  the fallback is in-shader bilinear (handles the NaN-edge fringe) or the
  `OES_texture_float_linear` extension. Bounded, observable, deferrable.
- **WCS grid-match hash.** The dataset manifest's gridHash decides which bands are
  composite-compatible; too strict rejects genuinely-aligned bands, too loose
  admits a half-pixel-off pair. The canonicalization/rounding is an M4 detail to
  validate against real multi-band data.
- **Tier divergence.** Without the single-`ViewerConfig` discipline (§3.5), the
  three tiers drift. Organizational risk as much as technical.
- **Static-host Range support.** The whole model assumes 206 range responses from
  the SSG's host. Most CDNs do; some naive static hosts don't. The SSG must
  document this and ideally detect/warn.
- **`block_reduce` edge trimming vs registration.** Independent per-level trimming
  means a fine level can extend a few pixels past a coarse ancestor (already
  handled by a UV clamp). For RGB, same-grid bands trim identically so tiles
  align; for overlays it slightly perturbs the level↔sky mapping at the high edge.

---

## 7. Explicitly deferred work

Not in v1.0, restated to anchor scope: region selection / measurement; HiPS
underlay; animation/blinking; mobile/touch polish; multi-extension FITS UI;
SIP/TPV distortion (still **rejected** by `fitsgl`, not handled); spectral
cubes. Also out: non-ICRS coordinate systems; arbitrary N-band beyond the three
RGB channels; in-browser resampling of mismatched-WCS bands (D7); arbitrary
polygon region overlays (simple shapes only, D10); overlay-driven measurement.
LINEAR/bilinear filtering is out of v1.0 unless the M2 visual check forces it
(D3). Stated so that, e.g., "the overlay layer could also do measurement" does
not quietly expand M3.

Large-field **tiled-mosaic rendering** is likewise out of v1.0 — but, unlike the
above, it is **planned as M6** (§2.7, §5), not indefinitely deferred.
