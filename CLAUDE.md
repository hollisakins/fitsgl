# FitsGL

A cloud-optimized, browser-native FITS rendering engine. Python converts FITS
mosaics into multi-resolution fpacked tile pyramids; TypeScript decodes the
tiles over HTTP range requests and renders them in WebGL2.

The v1.0 plan and the locked design decisions live in `docs/roadmap-v1.md` —
read it before non-trivial work. `notes/phase*.md` are historical implementation
records (the top-level `PHASE*.md` are the original specs); trust the code over
both.

## Layout

- `pyramid_gen/` — Python pipeline. Reads a FITS mosaic, writes one fpacked
  `.fits.fz` per resolution level (z=0 GZIP_2 lossless; z>0 RICE_1 lossy) plus
  a `manifest.json`. Entry: `pyramid_gen.build_pyramid.build_pyramid`.
- `fits-pyramid/` — TypeScript library (single entry `src/index.ts`):
  `rice/` (RICE decode), `fpack/` (file parsing + tile fetch over range
  requests, `TilePyramid`), `renderer/` (`FitsViewer`, WebGL2). Builds with
  `tsc` (no bundler).
- `demo/` — Vite app for end-to-end visual verification.

## Commands

```bash
# Python
cd pyramid_gen && pip install -e ".[test]" && pytest
python -m pyramid_gen path/to/mosaic.fits -o out/   # build a pyramid

# TypeScript library
cd fits-pyramid && npm install
npm test          # vitest
npm run typecheck # tsc --noEmit
npm run build     # tsc -> dist/

# Demo
cd demo && npm install && npm run build-pyramid && npm run dev
```

## Conventions

- **Decode correctness is gated by tests against astropy-generated fixtures.**
  RICE/GZIP_2 round-trips are exact (z=0 lossless); never weaken a decode test
  or add tolerance — fix the code.
- TypeScript is `strict`, **no `any`**. Pure logic (camera/tile/coord math) is
  split from GL/DOM side effects so it unit-tests under Node.
- No frameworks in the core renderer (raw WebGL2) and no third-party FITS/gunzip
  libraries — browser-native `DecompressionStream`, hand-written RICE.
- The manifest is a convenience index; the `.fits.fz` files are self-describing
  and authoritative (verify `ZCMPTYPE` from the file, not the manifest hint).
- Run tests/typecheck after changes. Commit only when asked.
