# FitsGL

A cloud-optimized, browser-native FITS rendering engine. The Python pipeline
(`fitsgl-py`) converts FITS mosaics into multi-resolution fpacked tile pyramids
and publishes a self-contained, deployable viewer site; the TypeScript library
(`fitsgl-core`) decodes the tiles over HTTP range requests and renders them in
WebGL2.

**The code is the source of truth.** This file captures the load-bearing
invariants and decisions that are *not* obvious from reading the code. End-user
how-to lives in `docs/`: `docs/cli.md` (the producer CLI), `docs/core-integration.md`
(consuming `@fitsgl/core`), `docs/server-reads.md` (the Python read-side/cutout
API — `tiles`/`fpack_index`/`cutout`), and `docs/r2-setup.md` (Cloudflare R2 hosting).

## Layout

- `fitsgl-py/` — Python pipeline + producer CLI (pip package `fitsgl`). The
  primary entry is the `fitsgl` CLI (`fitsgl.cli:main`), a 7-subcommand pipeline:
  `init`, `build`, `demo`, `serve`, `verify`, `deploy`, `index`. `fitsgl build`
  emits a self-contained dataset dir — one per-band pyramid dir (each a
  `manifest.json` + `.fits.fz` tiles), an optional `catalog.csv`, a `fitsgl.json`
  written last as the completeness marker, and a copy of the vendored viewer
  (`index.html` + `assets/`). `python -m fitsgl` / `fitsgl-gen`
  (`fitsgl.__main__:main`, `build_pyramid.build_pyramid`) is the low-level
  single-pyramid primitive. Every pyramid level is a display-only product:
  `RICE_1`, `quantize_level=8`, `SUBTRACTIVE_DITHER_2` (lossy but ~0.03%
  photometry-faithful; the raw lossless mosaic ships separately).
- `fitsgl-core/` — TypeScript library (npm `@fitsgl/core`). Three entry subpaths:
  `.` (`src/index.ts`, a deliberately **narrow** public API — D11), `./react`
  (`src/react/index.tsx` — the `<FitsExplorer>` + `<FitsViewer>` React tier), and
  `./internal` (`src/internal.ts` — decoders/`FpackFile`/`TileEngine`/grid
  helpers; **not** a stability contract, may change without a semver bump).
  Internals: `rice/` (RICE decode), `fpack/` (file parsing + range-request tile
  fetch, `TilePyramid`, caches, decode workers), `renderer/` (`FitsViewer`,
  WebGL2), `wcs/`, `overlay/`. Builds with `tsc` (no bundler).
- `demo/` — Vite app for end-to-end visual verification through the vanilla
  (non-React) stack (npm `@fitsgl/demo`).
- `viewer/` — the SSG viewer app (npm `@fitsgl/viewer`; Vite + the `@fitsgl/core`
  React `<FitsExplorer>`). `npm --prefix viewer run build-vendor` compiles it into
  `fitsgl-py/src/fitsgl/_viewer/` — the committed bundle that `fitsgl build`
  copies next to a dataset to emit a self-contained, deployable site.

## On-disk formats

- **The pyramid manifest is version 2** (`MANIFEST_VERSION=2`; TS
  `SUPPORTED_MANIFEST_VERSION=2` accepts both 1 and 2). Each level carries a
  disjoint `supertiles[]` list — standalone `.fits.fz` rectangles, each with a
  `tile_origin`/`tile_count`, that pave the grid — while the level keeps its
  TOTAL `fpack_tile_count` so tile-manager math is unchanged. Supertiles
  auto-chunk levels under Cloudflare's ~512 MB object cap and ingest pre-tiled
  mosaics. v1/version-less levels are read by synthesizing one supertile covering
  the whole grid (back-compat shim, D9 — never break it). Client lookup is
  `resolveSupertile(level, x, y)`, an exact containment test (works because
  supertiles are disjoint; pre-tiled overlaps are trimmed at parse time, not by
  client priority).
- **Four versioned JSON contracts**, each defined in both Python and TS: per-band
  `manifest.json` (v2); `dataset.json` (`DATASET_VERSION=1`, legacy/bridged);
  `fitsgl.json` (`FITSGL_SCHEMA_VERSION=1`, the producer contract the viewer
  gates on); `collection.json` (`COLLECTION_SCHEMA_VERSION=1`, the multi-field
  landing page). Plus `catalog.csv` (`CATALOG_VERSION=1`) and the deploy ledger
  `deploy-manifest.json`. The manifest is a convenience index; the `.fits.fz`
  files are self-describing and authoritative (verify `ZCMPTYPE` from the file,
  not the manifest hint).
- A band input accepts a single path, a list, or a glob. Multiple inputs are
  treated as pre-tiled tiles that must share CTYPE/CRVAL/scale and differ only by
  integer-phase CRPIX, else the build fails (SP8). No reprojection/drizzle (SP7).

## Multi-field workspaces

`fitsgl.workspace.toml` drives multi-field builds/deploys: a shared `[deploy]`
block plus one prefix per `[[field]]`. Use `fitsgl build -w`, `fitsgl deploy -w`,
and `fitsgl index`; deploy emits and ships a `collection.json` landing page at
the deploy root. See `docs/cli.md`.

## Commands

```bash
# Producer CLI (pip package `fitsgl`)
cd fitsgl-py && pip install -e ".[test]" && pytest
fitsgl demo --serve                            # synthetic dataset, built + served (quickstart)
fitsgl init && fitsgl build && fitsgl serve    # real data: scaffold -> build -> preview locally
fitsgl deploy                                  # publish to Cloudflare R2 (needs fitsgl[deploy])
python -m fitsgl path/to/mosaic.fits -o out/   # low-level single-pyramid primitive (fitsgl-gen)

# TypeScript library (npm `@fitsgl/core`)
cd fitsgl-core && npm install
npm test          # vitest
npm run typecheck # tsc --noEmit
npm run build     # tsc -> dist/

# Demo (vanilla stack, end-to-end visual check)
cd demo && npm install && npm run build-pyramid && npm run dev

# SSG viewer bundle — re-vendor after ANY change to fitsgl-core/ or viewer/
# source, or the bundle `fitsgl build` ships stays stale. A fitsgl-py test
# (test_vendored_viewer_is_fresh) fails until you do; commit the rebuilt
# fitsgl-py/src/fitsgl/_viewer/. To refresh only the site in an already-built
# dataset afterwards: `fitsgl build --site-only`.
npm --prefix viewer run build-vendor
```

**Releasing `@fitsgl/core` to npm:** bump `fitsgl-core/package.json` `version`,
then push a matching `core-v<version>` tag — `.github/workflows/publish-core.yml`
runs typecheck + tests and `npm publish` (public, with provenance) from
`fitsgl-core/`. The tag prefix keeps it distinct from any `fitsgl-py` release. A
`prepare` hook builds `dist/` (gitignored) at pack time; the `core-v*` tag must
equal the package version or the workflow fails. Needs the `NPM_TOKEN` repo
secret. npm can't consume the `fitsgl-core/` subdir as a git dep — the published
package is the supported consumption path (pnpm/yarn can pin a git subdir; see
`docs/core-integration.md`).

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
- **Client cache/decode topology ("Shape B").** Three tiers: GPU textures → RAM
  LRU (decoded `Float32Array`) → persistent IndexedDB disk tier holding the
  *compressed* bytes, behind an injectable `BlobStore` (the null-store falls back
  to network on incognito/quota). Decode runs on a pool of **stateless** workers,
  round-robin routed; the main-thread `TileEngine` owns manifest/fetch/disk-cache/
  dedup. Do **not** move disk or metadata into the workers. The disk tier is
  namespaced by a content hash of the manifest (there is no `build_id` yet), so a
  rebuilt pyramid auto-invalidates.
- **Deploy invariants** (`deploy.py`/`deploy_plan.py`; `docs/r2-setup.md` covers
  the one-time R2/Cloudflare setup). Push-then-purge, never the reverse — purging
  first just re-caches stale bytes from R2. Write the `deploy-manifest.json`
  ledger LAST, after the purge, so an interrupted upload or failed purge
  self-heals on the next run. Diff on `sha256` + the serving `Cache-Control`,
  never the R2 ETag (a multipart ETag is not comparable to a local hash). Three
  cache classes: tiles (`max-age` + `stale-while-revalidate`), pointers/JSON
  (`no-cache` + ETag), content-hashed assets (`immutable`). `.fits.fz` is not on
  Cloudflare's default cacheable-extension allowlist, so a deploy needs a manual
  per-zone Cache Rule (`fitsgl verify` flags its absence), and the R2 token must
  be Admin Read & Write (deploy calls `put_bucket_cors`).
- **These look like bugs but are intentional v1.0 decisions — don't "fix" them.**
  NEAREST-only texture filtering (D3: R32F is not linearly filterable in core
  WebGL2; LINEAR is used only for the colormap LUT). Multi-tile mosaics (M6/D14)
  are deliberately unbuilt — the loader hard-rejects any band with
  `tiles.length > 1` (this is distinct from the supertile format, which *did*
  ship for large/pre-tiled mosaics). SIP/TPV-distorted WCS is rejected by the
  builder (ICRS+TAN only).
- Run tests/typecheck after changes. Commit after major milestones.
