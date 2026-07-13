# Dev preview: testing `@fitsgl/core` changes against real R2 tiles

The production flow (`fitsgl build` → `fitsgl deploy`) is the wrong loop for
iterating on the TypeScript engine: every frontend change would mean a manual
re-deploy into the bucket. This page sets up the fast loop instead — a **Vercel
app that builds the `viewer/` frontend from any branch and fetches tiles
directly from your existing R2 datasets**. Every push gets a preview URL, so a
PR that changes `fitsgl-core` is viewable live, against real data, with no
deploy step and **no bucket credentials** (the tiles are already public behind
your Cloudflare domain; the browser fetches them exactly as production does —
same range requests, same Cache Rule, same HTTP/2 — which is what makes preview
deployments valid for performance work).

## How it works

Two small hooks in the viewer app enable this; both are inert in the vendored
production bundle:

- **`VITE_FITSGL_DATASET`** (build-time env var): the default dataset directory
  URL the app loads instead of `document.baseURI`. Setting it marks the build as
  a dev/preview build.
- **`?dataset=<url>`** (runtime query param): overrides the default, so one
  deployment can view any public dataset — a field subdirectory, a different
  bucket, anything with CORS open to the app's origin. Honored **only** when
  `VITE_FITSGL_DATASET` was set at build time, so a shipped production site's
  data source can never be swapped by a crafted link.

Either value may be the dataset directory (`https://tiles.example.com/cosmos/`)
or a direct pointer to its `fitsgl.json` / `collection.json`. Pointing at a
deploy root with a `collection.json` works too — the field picker's cards route
through `?dataset=` so you stay inside the preview app.

`FITSGL_VIEWER_OUTDIR` (see `viewer/vite.config.ts`) redirects the build output
away from the committed vendor artifact (`fitsgl-py/src/fitsgl/_viewer/`) so a
preview build never touches it.

## One-time setup

### 1. Vercel project

1. [vercel.com](https://vercel.com) → **Add New… → Project** → import the
   `fitsgl` GitHub repo. The root `vercel.json` supplies the install/build
   commands and output directory — leave framework/build settings alone.
2. Project **Settings → Environment Variables**: add
   `VITE_FITSGL_DATASET` = `https://<your-domain>/<prefix>/` (your dataset's
   directory URL — the place its `fitsgl.json` lives). Apply to Production and
   Preview.
3. Deploy. Every subsequent push to any branch produces a preview URL in the PR.

### 2. Bucket CORS

Check `viewer_origin` in your `fitsgl.toml` `[deploy]` block:

- **Not set** → it defaults to `*`: every origin is already allowed. Skip this
  step.
- **Pinned to your site's origin** → add the dev origins (re-runnable; merges
  into the existing rule):

  ```bash
  # same env vars as `fitsgl deploy`
  export R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=…
  python scripts/set_dev_cors.py \
      --bucket <bucket> \
      --endpoint https://<account-id>.r2.cloudflarestorage.com \
      https://<project>.vercel.app "https://*.vercel.app" http://localhost:5173
  ```

  R2 allows one `*` wildcard per origin, so `https://*.vercel.app` covers every
  per-branch preview URL.

  **Caveat:** `fitsgl deploy` resets bucket CORS to the single `viewer_origin`
  on every run, wiping these — re-run the script after a deploy (or ask for a
  `--cors-origins` deploy option if this gets old).

## The loop

1. Branch, edit `fitsgl-core/`, push.
2. Vercel builds (`fitsgl-core` `tsc` → `viewer` Vite build) and comments the
   preview URL on the PR.
3. Open the preview; it loads your R2 dataset. Add `?dataset=…` to point the
   same deployment at another field/dataset — e.g. to A/B two branches on the
   same data, open each branch's preview URL side by side.

Profiling notes (see the fitsgl-core performance review): preview builds are
production-minified, tiles come straight from Cloudflare, so Chrome DevTools
Performance recordings and the Network waterfall on a preview URL are
representative. Compare against `main`'s preview for before/after.

## Local equivalent (when working on a machine)

```bash
npm --prefix fitsgl-core install && npm --prefix viewer install
npm --prefix fitsgl-core run build -- --watch &   # recompiles core on save
VITE_FITSGL_DATASET=https://<your-domain>/<prefix>/ npm --prefix viewer run dev
```

The Vite dev server aliases `@fitsgl/core` to the compiled `dist/`, so the
`tsc --watch` output hot-reloads into the page. Requires `http://localhost:5173`
in the bucket CORS (see above).
