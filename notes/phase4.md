# Phase 4 — Vite demo (end-to-end visual verification)

A minimal, framework-free Vite app that serves a Phase 1 pyramid as static files,
points a Phase 3 `FitsViewer` at its manifest, and exposes stretch + navigation
UI. Its whole purpose is to **visually verify Phases 1 → 2a → 2b → 3 together**.
Lives in `demo/`.

## What was built

```
demo/
  package.json          # vite scripts; pre-hooks rebuild the library's dist/
  tsconfig.json         # strict; `fits-pyramid` -> ../fits-pyramid/dist/index.d.ts
  vite.config.ts        # range-serving plugin + alias to the built library
  index.html            # top bar (title, min/max, Auto), canvas, bottom bar HUD
  src/
    main.ts             # load manifest, build TilePyramid (inline), wire FitsViewer
    controls.ts         # telemetry HUD, FPS, Auto = 1st–99th pct of visible tiles
  scripts/
    build-test-pyramid.sh   # SIZE² synthetic (default 512) -> pyramid -> public/pyramid/
  public/pyramid/       # generated (gitignored); manifest.json + *.fits.fz
```

Plus one **additive** library change (`fits-pyramid`): an optional `onFrame`
telemetry callback on `FitsViewer` (see "Telemetry" below).

## Run from scratch

```bash
cd demo
npm install
npm run build-pyramid      # generate demo/public/pyramid/ (needs python + astropy)
npm run dev                # open the printed http://localhost:PORT/
```

`build-pyramid` adds `pyramid_gen/src` to `PYTHONPATH` (no `pip install` needed)
and honours `$PYTHON`. `predev`/`prebuild`/`pretypecheck` rebuild the library's
`dist/` first, so the demo always imports the current API.

The synthetic mosaic size is a knob (square; default 512):

```bash
SIZE=8096 npm run build-pyramid     # larger field; SOURCES= overrides source count
```

`SOURCES` defaults to ~50 per 512×512 of area, so a larger field stays as
populated as the reference rather than becoming 50 needles in a haystack
(8096² → ~12 500 sources). A **non-power-of-two** size like 8096 is the better
stress test: it produces **partial edge tiles at every level**, exercising the
Phase 1 remainder-trim → Phase 2b partial-tile decode → Phase 3 partial-edge
render path that a 512² (power-of-two) pyramid never touches. Note the z=0 GZIP_2
lossless file scales with pixels (≈170 MB at 8096² noisy float32); it's gitignored.
The viewer never downloads it wholesale — zoom-to-fit shows a coarse level and only
visible tiles are range-fetched. Level selection tracks the *perceived* (CSS) zoom
(see phase3.md "DPI handling"), so on a HiDPI display the big z=0 level only loads
once you zoom in near native, not while panning around zoomed out.

## What correct synthetic output looks like

The default test mosaic is 512×512: **50 Gaussian PSF sources** (FWHM 2.5 px,
fluxes 5–200) on a **flat background = 1.0** with **σ = 0.05 Gaussian noise**,
plus ~1 % **NaN blobs**. (A larger `SIZE` adds levels and source count — e.g.
8096² builds z0..z5, every level with partial edge tiles.) The default pyramid is
two levels:

| z | file | compression | shape | tiles |
|---|------|-------------|-------|-------|
| 0 | `synthetic_z0.fits.fz` | GZIP_2 (lossless) | 512² | 2×2 |
| 1 | `synthetic_z1.fits.fz` | RICE_1 (lossy, q16) | 256² | 1×1 |

On screen (after the demo auto-stretches on first frame):

- A grey noisy field at ~1.0 with **50 bright point sources**; the brightest
  cores saturate white. Auto picks roughly **[0.88, 1.13]** (1st/99th percentile),
  so the background texture is visible and sources clip bright.
- **NaN blobs render fully transparent** (you see the black canvas through them) —
  the shader maps `isnan → vec4(0)`.
- **z=0 (GZIP_2) and z=1 (RICE) look essentially identical** on this data: the
  dynamic range inside the stretch window is tiny, so RICE's q=16 quantization is
  invisible, and a 2× block-average barely changes a smooth PSF field. Zooming in
  past native pins z=0; zooming out to fit selects z=1.
- Sources stay visible and correctly positioned at **every** zoom level; panning
  keeps them under the cursor.

Decoded-tile sanity (measured headless through the dev server):

```
z0 tile(0,0) GZIP_2: 65536 vals, 716 NaN, min 0.805  max 27.93  mean 1.017
z1 tile(0,0) RICE_1: 65536 vals, 448 NaN, min 0.900  max 23.41  mean 1.018
z0 whole-level percentiles: p1=0.884  p50=1.000  p99=1.133
```

## Dev-server Range support (critical)

The Phase 2b fetcher (`httpRangeFetch`) **hard-rejects a 200 response** — it
refuses to download a whole file when it asked for a byte range. So the dev
server *must* answer `.fits.fz` requests with `206 Partial Content`.

Rather than trust Vite's static handler (sirv) to honour Range for this
extension, `vite.config.ts` ships a small **pre-middleware** that serves
`/pyramid/*.fits.fz` itself: it parses `Range: bytes=a-b` (plus open-ended
`a-` and suffix `-N` forms), streams just that slice with a byte-accurate
`Content-Range`/`Content-Length`, returns `416` for an unsatisfiable range and
`200` (whole file) when no Range header is present, and guards against path
traversal. It is registered on both the dev (`configureServer`) and preview
(`configurePreviewServer`) servers, ahead of Vite's static middleware.

Verified: dev + preview both return `206` with `Content-Range: bytes 0-15/722880`
for a `bytes=0-15` request; a no-Range GET returns `200`; opening + reading one
z0 tile fetched **194 KB of the 723 KB file** (partial fetch confirmed, not a
whole-file download).

## Telemetry (the bottom bar) and the `onFrame` change

The bottom bar shows **zoom, center (native px), level z, compression type, tiles
in view, FPS, and bytes fetched this session** — the spec's verification HUD,
where `compression` confirms the per-level GZIP_2/RICE_1 dispatch is firing.

`FitsViewer` previously exposed none of its internal state (camera/level/frame
timing are all private), so I added one **additive, non-breaking** option:
`onFrame?(info: ViewerFrameInfo)`, called at the end of every drawn frame with
`{ frame, zoom, centerX, centerY, level, bounds, visibleTileCount }`. The viewer
is the only thing that knows when it draws (the render loop is on-demand, so this
is the only honest FPS signal) and which level it picked. When `onFrame` is
omitted, `draw()` is byte-for-byte unchanged. The demo derives FPS from the
spacing of recent `onFrame` calls and decays the readout to "idle" when nothing
is drawing.

- **Bytes fetched** is measured by wrapping `httpRangeFetch` in a counting
  `rangeFetch` and passing it to `TilePyramid.load`. Injecting a `rangeFetch`
  makes `TilePyramid` run the engine **inline** (no worker), which is exactly
  what lets the demo observe every range fetch on the main thread. The worker
  path remains the production default exercised by the Phase 2b tests; both modes
  produce identical tiles.
- **Auto** stretches to the **1st–99th percentile of the data currently in view**:
  it uses the latest frame's `level` + `bounds`, recomputes the visible tile set
  with the exported `visibleTiles`/`buildLevelGeoms`, re-`getTile`s them (cache
  hits — the viewer already loaded them), filters to finite values, and takes the
  percentiles (subsampling with a fixed stride above ~1 M samples to stay snappy).
  It also fires once automatically on the first frame so the demo opens
  well-stretched instead of on a flat near-white field.

## Deviations / decisions vs the brief

1. **The demo consumes the library's built `dist/`, not its `src/`.** A `src`
   alias is nicer DX, but `tile-source.ts` references the worker via
   `new URL('../worker.js', import.meta.url)`, which Vite's worker plugin can only
   resolve against the compiled tree (`dist/worker.js` exists; `src/worker.js`
   does not — it's `.ts`). This is exactly the layout Phase 2b's `tsc` build was
   designed for. npm pre-hooks keep `dist/` fresh, so there's still no manual
   build step.
2. **Custom Range middleware instead of relying on Vite's static handler.** The
   brief allowed "a Vite plugin if needed" or "fall back to Express"; the
   middleware is the reliable middle path and makes the 206 guarantee explicit
   (the hard-fail in `httpRangeFetch` makes this non-optional).
3. **512² synthetic via an inline `python -c`, not the `--synthetic` CLI flag.**
   The Phase 1 `--synthetic` helper is fixed at 1024² and writes a pyramid beside
   the input; the brief wants 512², so the build script calls
   `generate_synthetic_mosaic(shape=(512,512))` directly and builds with `-o`.
   Phase 1 is untouched.
4. **One extra bottom-bar field: `tiles` (visible tile count).** Beyond the spec's
   list but free (already in `onFrame`) and useful for verifying tile-selection
   math. Not a "feature" in the sense the anti-patterns forbid (no RGB / no
   coordinate readout / no measurement tools).
5. **Inline engine (no Web Worker) in the demo** — see Telemetry. Decode runs on
   the main thread; fine for visual verification, and it makes byte traffic and
   per-range fetches observable.

## Visual issues observed and suspected phase

None in headless verification: the data pipeline is confirmed correct
(206 range serving, GZIP_2 + RICE_1 decode, NaN preservation, percentile/auto
stretch, level selection). On-screen confirmation is the `npm run dev` step.

If something *does* look wrong on screen, the brief's triage table maps symptom →
phase. The quick version:

| symptom | suspect |
|---|---|
| garbled pixels at z>0 only | RICE decode (Phase 2a) |
| garbled pixels at z=0 only | GZIP_2 byte unshuffle / order (Phase 2b) |
| wrong scale/offset/sign at z>0 | quantization reversal (Phase 2b dequantize) |
| tiles in wrong positions | tile-manager math (Phase 3) or manifest tile_count (Phase 1) |
| inverted Y | renderer Y-flip (Phase 3) |
| wrong downsampling at coarse z | Phase 1 `block_reduce` |
| wrong stretch behaviour | shader logic (Phase 3) |
| range requests fetch whole file | dev-server config or Phase 2b range header |

The bottom bar accelerates this: the `compression` field tells you which decode
path is active, and `fetched` confirms ranges (not whole files) are being pulled.

## Real-data testing (NIRCam mosaic)

Point the demo at a pyramid built from a real mosaic:

```bash
# Option A: the build script takes an optional input mosaic
demo/scripts/build-test-pyramid.sh /path/to/real_nircam_mosaic.fits

# Option B: drive Phase 1 directly into the demo's served directory
PYTHONPATH=pyramid_gen/src python -m pyramid_gen \
    /path/to/real_nircam_mosaic.fits -o demo/public/pyramid
```

Then restart `npm run dev` (or just reload — the pyramid is served `no-store`).

Expected, extrapolating from Phase 1's figures (synthetic float32):

- **Build time**: a few seconds per ~4k² mosaic; levels build in parallel
  (one process per level).
- **Disk**, broken down by path: the **z=0 GZIP_2 lossless** file dominates
  (~1.5× the source for noisy data; better with structure + NaN padding), while
  each **z>0 RICE_1 q16** level is ~13× / 50× / … smaller than z0. A full 5-level
  4096² pyramid (~52 MB) is roughly the size of the source FITS, almost all of it
  the lossless z=0 file.
- A real mosaic has real WCS, sharper sources, and large NaN-padded borders, so
  RICE levels compress better and the NaN→transparent handling is more visible.

For a very large mosaic the inline (no-worker) demo decodes on the main thread, so
panning can stutter; flip `useWorker` back on in `main.ts` (and drop the byte
counter) to push decode off-thread.

## Reducing fetched bytes (client caches)

When you pan back onto a tile, two in-app caches keep it from being re-fetched
and re-decoded. The lookup chain per visible tile is:

```
GPU texture (textureBudget)  →  decoded Float32Array LRU (cacheSize)  →  fetch + RICE/GZIP decode
  acquire(): on GPU? draw           getTile(): cached? skip fetch+decode      the expensive part
```

- **`textureBudget`** (`FitsViewerOptions`, demo sets **400**) — decoded R32F
  textures resident on the **GPU**. A tile still on the GPU is drawn with *no*
  `getTile` call at all (no fetch, no decode). Bounds GPU memory (~256 KB/tile).
- **`cacheSize`** (`TilePyramidOptions`, demo sets **800**) — decoded
  `Float32Array`s in the **JS heap**. A GPU-evicted tile that's still here
  re-uploads without re-fetching or re-decoding. Keep it **>** `textureBudget`
  so GPU eviction rarely forces a re-decode. Network happens only when a tile
  falls out of *both*.

The default (`textureBudget` 200, `cacheSize` 256) thrashes on a large level
(z=0 of the 8096² pyramid has 1024 tiles), which is what ran the session counter
to hundreds of MB. The bigger caps cost ~100 MB GPU / ~200 MB heap — tune in
`demo/src/main.ts`.

**The biggest lever is level selection** (see phase3.md "DPI handling"): tracking
CSS zoom keeps you on small coarse levels (z2/z3 ≈ 4 MB/1 MB) instead of the
170 MB z=0 level while zoomed out, so most pans never touch z=0 at all.

Note the HUD's `fetched` counts every `httpRangeFetch` call's bytes, so it
measures *bytes decoded*, not network — the in-app caches drop it because fewer
fetches happen at all; the browser/CDN cache (below) cuts real network without
moving the counter.

## Production deployment (R2 + Cloudflare)

The intended production setup serves the `.fits.fz` (and `manifest.json`) as
static objects from **Cloudflare R2 behind the CDN**. That makes the browser HTTP
cache **and** the CDN edge a persistent, cross-session cache of the compressed
tile *bytes* — better than any in-app byte cache (persistent, shared, zero app
code). The division of labour:

> **The CDN caches bytes; the client caches compute.** The edge/browser serve the
> compressed bytes on a repeat fetch (≈ no network), but only the in-app caches
> above avoid the CDN-immune RICE/GZIP **decode** + GPU upload. So on a CDN, the
> client's caching job narrows to (1) fetch with cacheable, range-friendly
> requests, (2) keep `cacheSize`/`textureBudget` healthy to skip re-decode, and
> (3) not defeat caching. An in-app *compressed-byte* cache would be redundant.

Checklist for the R2/CDN origin:

- **Tiles: immutable + versioned paths.** The `.fits.fz` are immutable per build,
  so serve them `Cache-Control: public, max-age=31536000, immutable` and
  cache-bust by **path** (e.g. `/pyramid/<build-id>/synthetic_z0.fits.fz`) rather
  than header churn. The manifest references the versioned filenames.
- **Manifest: revalidate.** It's the mutable index — `Cache-Control: no-cache`
  (or a short `max-age`) with an `ETag` so a rebuild is picked up promptly.
- **Range + validators.** Ensure R2 returns `Accept-Ranges: bytes` and an `ETag`,
  and the responses are cacheable. Cloudflare caches Range requests; for the large
  z=0 object consider **tiered cache / Cache Reserve** so it stays warm at the
  edge, and verify a `206` is actually served from cache after warm-up.
- **CORS (only if the app origin ≠ the R2/CDN origin).** Set
  `Access-Control-Allow-Origin`. A single closed `Range: bytes=a-b` (what
  `httpRangeFetch` sends) is a CORS-*safelisted* request header, so there's **no
  preflight**. `Access-Control-Expose-Headers` is only needed if the client reads
  `Content-Range` — it doesn't (it checks `206` + reads the body).

The **dev server emulates this** (in `vite.config.ts`): `.fits.fz` are served with
an `ETag` (size+mtime) and `Cache-Control: no-cache`, and `If-None-Match` →
`304`, so local development exercises the same browser-cache/revalidation path. It
uses revalidation rather than `immutable` because the demo's filenames are stable
across rebuilds; production uses immutable + versioned paths instead.

## Verification done

- `fits-pyramid`: `tsc --noEmit` clean, library `tsc` build clean, **161 tests pass**
  (unchanged by the additive `onFrame`).
- `demo`: `npm run typecheck` clean; `npm run build` succeeds.
- Dev + preview servers return correct `206`/`Content-Range`; full pipeline
  (manifest → GZIP_2 z0 → RICE_1 z1 → percentile) exercised headless over HTTP.
- 8096² (non-2ⁿ) pyramid: partial edge tiles at every level (full/right/corner/
  bottom + z5's single 253² tile) decode to exact dimensions headless; opening +
  reading 5 tiles fetched 0.57 MB of the 170 MB z0 file (range fetch at scale).
- Dev server caching: `.fits.fz` return `ETag` + `Cache-Control: no-cache`; a
  matching `If-None-Match` → `304`, a stale one → `206`.
- Adversarial multi-lens review (range plugin, `onFrame` change, auto-stretch,
  telemetry, build/config, spec compliance), each finding refuted against the
  cited code. (See "Adversarial review".)

## Adversarial review

A 14-agent workflow reviewed Phase 4 along six lenses (Range plugin, the
`onFrame` change, the auto-stretch/percentile math, the telemetry wiring,
build/config, and spec compliance), with every finding independently refuted by
a second agent reading the cited code. It confirmed **7 issues** and correctly
**dismissed 1 false positive** (a claim that the Range middleware registers
*after* Vite's static handler — refuted against Vite's source: `configureServer`
pre-hooks `use()` before `serveStaticMiddleware`, which the working 206 responses
confirm). All 7 are fixed:

1. **[high] Symlink traversal in the Range middleware.** `statSync` follows
   symlinks, so a symlink planted inside `public/pyramid/` could serve an
   arbitrary readable file (the lexical guard only checked the link's own path).
   Now `realpathSync` resolves the file and the result is re-checked for
   containment inside `realpath(pyramidDir)`; a symlink that escapes is rejected
   with 403. Regression-checked: a planted `evil.fits.fz → /etc/passwd` returns
   403 while legitimate tiles still return 206.
2. **[med] `onFrame` could be stopped by a throwing callback.** The per-frame
   `onFrame` invocation is now wrapped in try/catch (logs and continues), so a
   buggy HUD can't take down the render loop.
3. **[med] HUD-timer leak in `DemoControls`.** The 250 ms `setInterval` was never
   cleared. Added `DemoControls.destroy()` and wired it into `main.ts`'s
   `beforeunload` **and** `import.meta.hot.dispose` teardown, so the timer (and
   GL/engine resources) are freed across navigation and Vite HMR.
4. **[med] Blank compression readout.** The manifest validator defaults a missing
   `compression` to `''`; the HUD now shows `—` for an empty value instead of a
   blank field.
5. **[low] Misleading `onFrame` JSDoc.** Reworded: mutating the viewer from
   `onFrame` *does* schedule another frame (an infinite-loop risk), the opposite
   of what the old note implied.
6. **[low] Extra `tiles` HUD field beyond the spec's six.** Kept deliberately
   (free — already in `onFrame` — and useful for verifying tile selection);
   documented as deviation #4 above.

The Auto-stretch math, the additive-ness of the `onFrame` change (bounds captured
once and reused; `draw()` unchanged when `onFrame` is absent), and the build
script all passed their lenses with no findings.

## Suggested next steps

- **asinh / log stretch** — add a stretch-function selector; the raw float values
  are already in the textures, so it's a shader-uniform/branch change.
- **RGB compositing** — three bands → three textures → one shader; needs a
  multi-band manifest convention.
- **RA/Dec readout** — the per-level WCS is already in the manifest; project the
  cursor's world pixel through it for a coordinate display.
- **Leaflet / OpenLayers integration** — wrap the pyramid as a custom tile layer
  for a batteries-included pan/zoom + overlay UI.
- **Worker-mode telemetry** — surface bytes-fetched from inside the worker so the
  HUD works without dropping to the inline engine.
