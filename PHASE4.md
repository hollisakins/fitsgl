Build Phase 4: a minimal Vite-powered demo for visual verification of
the FITS tile renderer end to end.

## Goal

An HTML page that serves a pyramid as static files, instantiates
FitsViewer pointed at the manifest, and provides UI for stretch and
navigation. Primary purpose: visually verify Phases 1, 2a, 2b, and 3.

## Project structure

  demo/
    package.json
    vite.config.ts
    index.html
    src/
      main.ts
      controls.ts
    scripts/
      build-test-pyramid.sh
    public/
      pyramid/
  notes/
    phase4.md

## Dev server range request support

Critical: Vite's dev server must serve the pyramid files with proper
HTTP Range support (206 responses). Vite does this for static assets
by default; verify it works for .fits.fz specifically — add MIME-type
hint via a Vite plugin if needed.

If Vite is unreliable here, fall back to a tiny custom Express dev
server for the pyramid path.

## Setup script

scripts/build-test-pyramid.sh:
1. Run Phase 1 synthetic generator -> 512x512 test FITS
2. Run Phase 1 pyramid builder
3. Copy output to demo/public/pyramid/

After running, `npm run dev` yields a working demo.

## UI

Vanilla TypeScript, no framework. Native inputs. Layout:

- Top bar: title, stretch min/max inputs, "Auto" button (1st-99th
  percentile of visible tile data)
- Main area: canvas that fills available space, resizes on window
  resize
- Bottom bar: zoom, center coords, current pyramid level, FPS, bytes
  fetched this session, current level's compression type (RICE_1 or
  GZIP_2) — useful for confirming dispatch is working

## Real-data testing

Document in notes/phase4.md how to point at a pyramid built from a
real NIRCam mosaic:
- Run `python -m pyramid_gen path/to/real_mosaic.fits demo/public/pyramid/`
- Restart dev server
- Note expected build time and disk size, broken down by GZIP_2 z=0
  vs RICE_1 z>0 files

## Anti-patterns to avoid

- No frontend framework.
- No UI component library.
- No features beyond spec (no RGB, no coordinate readout, no
  measurement tools — future phases).

## Stop and ask if

- Visual output is wrong and you can't identify the responsible phase.
  Suspect ordering:
  * Garbled / random pixels at z>0:     RICE decompression (Phase 2a)
  * Garbled pixels at z=0 only:         GZIP_2 path (Phase 2b)
                                          — likely byte unshuffle or
                                          byte order
  * Wrong scale/offset/sign at z>0:     Quantization reversal (Phase 2b)
  * Tiles in wrong positions:           Tile manager math (Phase 3) or
                                          manifest tile_count (Phase 1)
  * Inverted Y axis:                    Renderer (FITS Y up vs screen
                                          Y down)
  * Wrong downsampling at coarse z:     Phase 1 block_reduce
  * Wrong stretch behavior:             Shader logic (Phase 3)
  * Range requests fetching whole file: Dev server config or Phase 2b
                                          range header

## Notes file

notes/phase4.md:
- How to run from scratch
- What correct synthetic output looks like (50 Gaussians on uniform
  background, visible at all zoom levels, identical visual appearance
  between z=0 (GZIP_2) and z=1 (RICE) on the synthetic data, since
  the dynamic range is small)
- Visual issues observed and suspected phase
- Real-data testing notes
- Suggested next steps (asinh stretch, RGB compositing, Leaflet
  integration, RA/Dec readout)