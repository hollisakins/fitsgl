# Phase 3 — WebGL2 tile viewer

A standalone, framework-free WebGL2 viewer that renders a Phase 2b `TilePyramid`
to a canvas with mouse pan, cursor-anchored scroll zoom, and an on-the-fly
linear stretch. Compression-agnostic: it consumes `Float32Array` tiles from
`pyramid.getTile(...)` and never touches RICE/GZIP details. Lives in
`fits-pyramid/src/renderer/`.

## What was built

- **`renderer/camera.ts`** — pure camera math (no DOM/GL): `worldToScreen` /
  `screenToWorld` (exact inverses), `panByScreen`, cursor-anchored `zoomAt`,
  `worldBounds`, and zoom clamping. Unit-tested directly.
- **`renderer/tile-manager.ts`** — pure tile-selection functions (`targetLevel`,
  `visibleTiles`, `tileWorldRect`, `tilePixelDims`, `coarserFallback`,
  `fallbackUV`, `selectEvictions`, `buildLevelGeoms`) plus the `TileManager`
  class that owns GPU textures (request → upload R32F → LRU evict, with in-flight
  de-dup). The math is split out from the GL so it is testable under Node.
- **`renderer/gl-util.ts`** — `createShader` / `createProgram` (throw with the
  info log on failure), `createUnitQuadVAO`, `createTileTexture` (R32F).
- **`renderer/shaders/tile.vert.ts`, `tile.frag.ts`** — GLSL ES 3.00 source
  strings. The fragment shader applies the linear stretch and maps NaN → fully
  transparent.
- **`renderer/viewer.ts`** — the `FitsViewer` class: wires camera + GL + tile
  manager, attaches its own mouse/wheel/resize handlers, and drives an on-demand
  render loop with coarse-level progressive refinement.
- **`renderer/index.ts`** — public API; also re-exported from the package root
  (`import { FitsViewer } from 'fits-pyramid'`).

## Coordinate systems

Three spaces, converted in this order each draw:

1. **World** = native image pixels, `(0,0)` top-left, x right, y **down**
   (matches FITS row/col and the browser screen). The camera lives here.
2. **Screen** = drawing-buffer pixels, y down. `worldToScreen` =
   `(w − center)·zoom + viewport/2`.
3. **NDC** (clip space), y **up**. The only Y flip in the whole pipeline lives in
   `viewer.drawTile`: `ndcY = 1 − 2·screenY/H`.

`zoom` is drawing-buffer pixels per world pixel (1.0 = native). Because the
canvas backing store is sized at `cssPixels × devicePixelRatio`, "16× native" is
stored as `16 · dpr` and "whole mosaic visible" as `min(W_buf/W_img, H_buf/H_img)`.

## Tile ↔ level math

Level convention matches the Phase 1 pyramid / manifest: **z=0 is native**, each
higher z halves resolution; `manifest.n_levels` = N is the deepest z (levels
0..N). A tile `(z, tx, ty)` covers `256·2^z` native px per side starting at
`(tx,ty)·256·2^z`.

- **Target level** (`targetLevel`): `z = clamp(round(−log2(zoom)), 0, N)`, i.e.
  `2^z ≈ 1/zoom` so one tile texel ≈ one screen pixel. Zooming out raises z
  (coarser); zooming in past native pins z=0.
  - **DPI handling.** `targetLevel` is pure and takes whatever zoom it's given;
    the viewer feeds it **CSS-pixel zoom** (`camera.zoom / dpr`) by default, so
    level selection tracks the *perceived* image size, not the device backing
    store. Without this, a HiDPI display runs `dpr`× ahead and keeps z=0 resident
    until the image is shrunk to `~0.35×` on screen (a 170 MB z=0 level's worth of
    tiles while zoomed out); CSS-zoom selection drops to coarser levels at
    `~0.71×` instead — ~4× fewer tiles/bytes, with native-and-in still on z=0.
    `FitsViewerOptions.hiDpiLevels: true` opts back into device-pixel selection
    (crisper on retina when zoomed out, 4× the tiles) — the equivalent of
    Leaflet's `detectRetina: true`.
- **Visible set** (`visibleTiles`): intersect the world viewport with the level's
  imaged area `[0, W_z·2^z) × [0, H_z·2^z)`, then `floor`-divide by the world tile
  span `256·2^z`. A `−1e-6` nudge on the exclusive max edge avoids pulling in an
  extra empty tile when the viewport ends exactly on a tile boundary. Returns `[]`
  when the viewport doesn't overlap the image.
- **Partial edge tiles**: the high-index tile of a non-256-divisible level is
  smaller than 256. `tilePixelDims`/`tileWorldRect` use the level's true pixel
  dimensions (from `manifest.levels[].shape`), so a 44-px-wide edge tile maps to
  44 world px (× 2^z), not 256 — and the uploaded texture is sized to match the
  `Float32Array` length Phase 2b returns.

## Progressive refinement

While a target-level tile is still loading, its screen area is filled from the
finest already-resident **coarser ancestor** (`coarserFallback` walks z+1, z+2,
… halving the tile index each step). `fallbackUV` computes the ancestor texture
sub-rectangle corresponding to the fine tile's world rect, so the coarse data is
drawn upscaled into exactly the right region. Each visible region is drawn once
per frame (fine tile if resident, else one ancestor) — no overdraw, so the
spec's flicker risk doesn't arise. When the fine tile arrives, its load callback
schedules a redraw and it paints over the placeholder.

Because the pyramid is built by *independent* per-level block-reduce with
remainder trimming, a fine level's imaged area can extend a few native pixels
past a coarser ancestor's at the high edge — so `fallbackUV` clamps its result
to `[0,1]` to keep the sample inside the ancestor texture (the overrun is at most
a sub-pixel sliver at the extreme image edge).

## GPU texture management

Decoded tiles are uploaded as **R32F** single-channel textures (core WebGL2, no
extension) with **NEAREST** filtering and clamp-to-edge. NEAREST is mandatory:
R32F is not filterable in core WebGL2; LINEAR would need
`OES_texture_float_linear` and is deferred (noted here per the brief). Raw float
pixel values stay in the texture untouched — the stretch is a pair of shader
uniforms (`u_min`, `u_max`), never baked in.

Budget is 200 textures (configurable via `FitsViewerOptions.textureBudget`),
evicted by `selectEvictions`: drop anything not visible for > 60 frames, then if
still over budget drop least-recently-visible survivors until under it — but
**never a tile drawn on the current frame**, so a viewport needing more than the
budget temporarily exceeds it rather than evicting-then-re-uploading tiles it
just drew (which would thrash/flicker). The upload also guards
`data.length === width·height` and skips with a warning on mismatch, so a pyramid
whose fpack tile size diverged from the assumed 256 can't silently render black.

The texture upload is **not** Y-flipped (`UNPACK_FLIP_Y_WEBGL` left at its
default false), so data row 0 (world-top) sits at texture `v=0`. `drawTile` maps
the world-top edge to `v=0` accordingly, so top-of-world renders at top-of-screen.

## Fragment shader

```glsl
float v = texture(u_tile, v_uv).r;
if (isnan(v)) { outColor = vec4(0.0); return; }   // blank/edge → transparent
float s = clamp((v - u_min) / (u_max - u_min), 0.0, 1.0);
outColor = vec4(s, s, s, 1.0);
```

`highp float` is required so large R32F values survive sampling. Blending is
enabled (`SRC_ALPHA, ONE_MINUS_SRC_ALPHA`) so NaN pixels show the black canvas
clear colour rather than a stretched garbage value.

## Rendering model

On demand, not a continuous loop: `requestRender()` schedules a single
`requestAnimationFrame` (guarded by a `renderScheduled` flag) whenever the camera
moves or a tile finishes loading. Idle ⇒ no frames. The frame counter advances
per draw and drives both visibility (LRU) and the >60-frame eviction.

## Interaction

- Left-drag → pan (`panByScreen`, content follows the cursor).
- Wheel → zoom anchored on the cursor's world point (`zoomAt`), exponential in
  `deltaY`. Bounded: out to whole-mosaic-visible, in to 16× native. The ceiling
  is never allowed below the fit zoom, so a mosaic smaller than the viewport
  (fit zoom > 16×) still fits rather than pinning at the 16× cap.
- `mousemove`/`mouseup` are bound on `window` (drag continues outside the canvas);
  `mousedown`/`wheel` on the canvas; a `ResizeObserver` keeps the backing store in
  sync with the displayed size. `destroy()` detaches exactly these, frees the GL
  program/VAO/textures, and leaves the caller-owned `TilePyramid` alone.

## Tests (Vitest, Node env)

`test/camera.test.ts` (9) and `test/tile-manager.test.ts` (29). Tests run under
Node with no WebGL/canvas, so they target the pure functions: transform
inverses, anchored-zoom invariance (including under clamp), pan translation,
`targetLevel` rounding/clamping, visible-tile sets (sub-tile, boundary, far,
clipped, non-overlapping, coarse-level, **partial-edge selection + past-imaged
clamp**), partial-edge `tileWorldRect`/`tilePixelDims`, `fallbackUV` (**non-origin
ancestor + [0,1] clamp**), finest-ancestor `coarserFallback`, and the idle+budget
eviction policy (**idle boundary, recency-vs-insertion ordering, current-frame
protection**). The GL classes are exercised only via their pure helpers. Full
package suite: 161 tests pass; `tsc --noEmit` and the `tsc` library build are
clean.

## Deviations / decisions vs the brief

1. **No Y flip in UV; the single flip is world→NDC.** The brief's shader is used
   verbatim; the data-row-0 → texture-v=0 mapping is handled by leaving
   `UNPACK_FLIP_Y` default and mapping world-top to `v=0` in `drawTile`.
2. **Per-tile world rects use true level dimensions**, so partial edge tiles
   render at their real size rather than an assumed `256·2^z`.
3. **Painter-free fallback.** Rather than drawing coarse-everywhere then fine on
   top, each region is drawn once (fine if resident, else one ancestor sub-rect),
   avoiding overdraw while still refining progressively.

## Adversarial review

A multi-agent workflow reviewed the renderer along six lenses (camera math, tile
selection, WebGL correctness, lifecycle/handlers, API/spec compliance, and test
quality), with every finding independently refuted by a second agent reading the
cited code. It confirmed ten issues (all minor) and correctly dismissed two
false positives (a `coarserFallback` "blank edge" that the unclamped loop already
handles, and a redundant zoom-anchor test). All ten are fixed and regression-
tested:

1. **Inverted zoom limits** — for a mosaic smaller than `viewport / 16`, the fit
   zoom exceeded the 16× ceiling, so `clampZoom` pinned the camera at 16× and
   `fitToImage` couldn't show the whole image. The ceiling is now never set below
   the fit zoom (`setZoomLimits` also guards `min ≤ max`).
2. **`fallbackUV` overrun** — trimmed (non-power-of-2) pyramid edges produced
   u/v > 1; now clamped to `[0,1]`.
3. **Budget eviction thrash** — the budget pass could drop tiles drawn on the
   current frame; current-frame tiles are now protected.
4. **Silent black on tile-size divergence** — the R32F upload now asserts the
   decoded length matches the 256-derived dims and skips+warns otherwise.
5. **Leaked quad vertex buffer** — `createUnitQuadVAO` now returns the buffer and
   `destroy()` deletes it (deleting a VAO does not free its buffers).
6–10. **Test blind spots** — added non-origin `fallbackUV`, partial-edge
   `visibleTiles`, the idle `==maxIdle` boundary, recency-vs-insertion eviction
   ordering, and current-frame eviction protection.

## Known limitations

- **NEAREST only** (no bilinear) until `OES_texture_float_linear` is wired up.
- **Single band**, linear stretch only — no RGB compositing, no asinh/log, no
  RA/Dec readout (all deferred per the brief).
- **One draw call per visible tile.** Fine at a 200-tile budget; an instanced or
  atlased path would matter only for very wide viewports.
- The viewer assumes the pyramid's levels are the standard power-of-two stack the
  Phase 1 pipeline emits; it does not re-derive level scale from per-level WCS.
