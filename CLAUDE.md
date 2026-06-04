# FitsGL

A cloud-optimized, browser-native FITS rendering engine. Python converts FITS
mosaics into multi-resolution fpacked tile pyramids; TypeScript decodes the
tiles over HTTP range requests and renders them in WebGL2.

The v1.0 plan and the locked design decisions live in `docs/roadmap-v1.md` —
read it before non-trivial work. `notes/phase*.md` are historical implementation
records (the top-level `PHASE*.md` are the original specs); trust the code over
both.

## Layout

- `fitsgl-py/` — Python pipeline (pip package `fitsgl`, CLI `fitsgl`). Reads a
  FITS mosaic, writes one fpacked `.fits.fz` per resolution level plus a
  `manifest.json`. Every level is a display-only product: `RICE_1`,
  `quantize_level=8`, `SUBTRACTIVE_DITHER_2` (lossy but ~0.03% photometry-faithful;
  the raw lossless mosaic ships separately). Entry: `fitsgl.build_pyramid.build_pyramid`.
- `fitsgl-core/` — TypeScript library (npm `@fitsgl/core`, single entry
  `src/index.ts`): `rice/` (RICE decode), `fpack/` (file parsing + tile fetch over
  range requests, `TilePyramid`), `renderer/` (`FitsViewer`, WebGL2). Builds with
  `tsc` (no bundler). The `@fitsgl/core/react` subpath ships the React tier.
- `demo/` — Vite app for end-to-end visual verification (npm `@fitsgl/demo`).
- `viewer/` — the SSG viewer app (npm `@fitsgl/viewer`; Vite + the `@fitsgl/core`
  React `<FitsExplorer>`). `npm run build-vendor` compiles it into
  `fitsgl-py/src/fitsgl/_viewer/` — the committed bundle that `fitsgl build` copies
  next to a dataset to emit a self-contained, deployable site.

## Commands

```bash
# Python (pip package `fitsgl`)
cd fitsgl-py && pip install -e ".[test]" && pytest
python -m fitsgl path/to/mosaic.fits -o out/   # build a pyramid (or the `fitsgl-gen` script)

# TypeScript library (npm `@fitsgl/core`)
cd fitsgl-core && npm install
npm test          # vitest
npm run typecheck # tsc --noEmit
npm run build     # tsc -> dist/

# Demo
cd demo && npm install && npm run build-pyramid && npm run dev

# SSG viewer bundle — re-vendor after ANY change to fitsgl-core/ or viewer/
# source, or the bundle `fitsgl build` ships stays stale. A fitsgl-py test
# (test_vendored_viewer_is_fresh) fails until you do; commit the rebuilt
# fitsgl-py/src/fitsgl/_viewer/. To refresh only the site in an already-built
# dataset afterwards: `fitsgl build --site-only`.
npm --prefix viewer run build-vendor
```

## Conventions

- **Decode correctness is gated by tests against astropy-generated fixtures.**
  RICE integer and GZIP_2 round-trips are bit-exact — never weaken those tests
  or add tolerance, fix the code. The lossy float dequant matches astropy
  exactly for `NO_DITHER` and the NaN-mask/exact-zero handling; with
  `SUBTRACTIVE_DITHER_2` the final float matches only to ≤1 float32 ULP, because
  astropy's C unquantizer fuses `value*ZSCALE+ZZERO` (FMA) and JS cannot — the
  FITS standard does not mandate FMA, so ≤1 ULP is the correct spec, and the
  dither index/formula themselves are exact (a logic bug diverges by many ULPs).
- TypeScript is `strict`, **no `any`**. Pure logic (camera/tile/coord math) is
  split from GL/DOM side effects so it unit-tests under Node.
- No frameworks in the core renderer (raw WebGL2) and no third-party FITS/gunzip
  libraries — browser-native `DecompressionStream`, hand-written RICE.
- The manifest is a convenience index; the `.fits.fz` files are self-describing
  and authoritative (verify `ZCMPTYPE` from the file, not the manifest hint).
- Run tests/typecheck after changes. Commit after major milestones.
