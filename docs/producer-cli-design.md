# FitsGL Producer CLI & Deployment UX — Design

A design document for the **producer-facing** surface of FitsGL: the experience of
the user who has FITS mosaics and wants to turn them into a deployed, viewable
FitsGL dataset. This is distinct from the *consumer* surface (the browser
renderer / `ViewerConfig`), which is specified in `roadmap-v1.md` and is largely
built. This document covers the parts the roadmap names but leaves unbuilt: the
multi-band build orchestration, a persisted site/view config, deployment, and the
producible frontend.

Scope: the end-to-end journey **mosaics → dataset → deploy → frontend**, the CLI
that drives it, and the on-disk layout it produces. It records design decisions
(with reasoning) in the roadmap's style; it does not change the locked v1.0
renderer scope.

Status: design only. Nothing here is implemented yet beyond the existing
`build_pyramid` primitive and the `dataset`/`catalog` helpers it would compose.

---

## 1. Current state (what a producer can do today)

One entry point exists: `python -m pyramid_gen` (`pyramid_gen/__main__.py`).

```
python -m pyramid_gen <inputs...> [-o OUT] [--tile-size 256]
                       [--quantize-level 8] [--processes N] [--synthetic PATH]
```

It builds **one mosaic → one pyramid directory** (`build_pyramid.build_pyramid`):

- single input → `<stem>_pyramid/` beside the input, with
  `<stem>_z0.fits.fz … _zN.fits.fz` + `manifest.json`;
- multiple inputs → each gets its own sibling dir; `-o` is rejected with >1 input;
- the `.fits.fz` files are self-describing and authoritative; the manifest is a
  convenience index (every level is RICE_1, `quantize_level=8`,
  `SUBTRACTIVE_DITHER_2` — display-only).

This primitive is solid and well tested. Everything *above* one pyramid is **not**
in the CLI and exists only as Python helpers invoked from the demo's
`build-test-pyramid.sh` through `python - <<'PY'` heredocs:

- `dataset.build_dataset(...)` → `dataset.json` (band grouping + `default_rgb` +
  grid hash) — CLI-inaccessible;
- `catalog.write_catalog_csv(...)` → `catalog.csv` — the real-mosaic CLI path
  *discards* the catalog; only `--synthetic` keeps it;
- no deploy step of any kind;
- no producible frontend — `demo/` and `demo-react/` are verification harnesses
  with a hardcoded `/pyramid/` path and hand-written `discover()` logic. The
  roadmap's vanilla-embed and SSG tiers (§3.3/§3.4) do not exist yet, and can't
  until the library gains a bundler (it is `tsc`-only).

### 1.1 Friction this design resolves

1. **A dataset is one deliverable, but the CLI can't express it.** Co-gridded
   bands form a single product (one `dataset.json`, one viewer); the CLI scatters
   them into sibling `*_pyramid/` dirs with no grouping.
2. **Multi-band orchestration is trapped in bash + heredocs.** The only place a
   real multi-band + dataset + catalog build happens is a demo script — and the
   heredoc pattern is known-harmful (multiprocessing under `python -` floods the
   console with `<stdin>` errors).
3. **Overlays have no producer story on real data** — `catalog.csv` is only ever
   produced for synthetic input.
4. **No persisted view config.** Default stretch / colormap / north-up / RGB roles
   live in demo React state or in `default_rgb`. The roadmap repeatedly references
   a "site config" (§2.2, §3.4) that was never built.
5. **Three names for one project**: `pyramid_gen` (CLI), `fits-pyramid` (lib),
   "FitsGL" (brand).

---

## 2. The organizing idea

**A FitsGL dataset is a single directory, described by a single config file, that
is also a deployable website.** One config in, one self-contained directory out;
deployment is copying that directory to any host that supports HTTP Range.

This collapses *generate*, *configure*, *deploy*, and *frontend* into one object
with one contract. The contract is `viewer-config.json` — the exact `ViewerConfig`
type the TypeScript already consumes (`fits-pyramid/src/viewer-config.ts`). The
producer **emits** the contract; every delivery tier **consumes** it; no tier
restates it. This closes the roadmap's §3.5 tier-divergence risk at the data
layer (today `demo-react`'s `discover()` reconstructs the config client-side).

---

## 3. Decisions log

| # | Area | Decision | Reasoning |
|---|---|---|---|
| P1 | Tool shape | **One `fitsgl` CLI with subcommands** (`init`/`build`/`serve`/`deploy`); keep `build_pyramid` as the internal per-band primitive it calls. | Unifies the brand, gives the multi-band path a home, and keeps the tested single-pyramid primitive unchanged. `python -m pyramid_gen` stays as a low-level escape hatch. |
| P2 | Configuration | **Config file (`fitsgl.toml`) is the source of truth** for a multi-band dataset; flags are sugar for one-offs. | RGB roles + catalog + view + deploy don't fit flags; a file is reviewable, diffable, and is the long-missing "site config." |
| P3 | Output model | **One dataset = one output directory** containing every band, the manifests, the catalog, `viewer-config.json`, and (SSG) the page + embed bundle. | Makes "deploy" a directory copy and gives the producer a single mental object. |
| P4 | View config home | The `[view]` block in `fitsgl.toml` is serialized into **`viewer-config.json`** at build time. | One persisted place for default stretch/colormap/north-up/RGB; identical to the type all three tiers read. |
| P5 | Orchestration | `fitsgl build` runs the multi-band + dataset + catalog flow **in-process, no stdin heredocs**. | Directly fixes the known multiprocessing-under-`python -` failure; moves demo glue into a real, testable command. |
| P6 | Local verification | `fitsgl serve` promotes the demo's byte-accurate **HTTP Range/206 middleware** (`demo/vite.config.ts`) into a first-class command. | The single biggest deploy footgun is a non-Range host; a faithful local mirror catches it before upload. |
| P7 | Deploy abstraction | Deploy targets are **(a) a local/static dir (copy/rsync), (b) R2/S3**. R2/S3 uploads set `Content-Type` + the right cache headers per file class; both require Range (documented). The concrete artifacts, cache policy, and CORS are specified in **§9**. | The dataset is already a static dir; "deploy" is upload-with-correct-headers. R2/S3 support Range natively and are the recommended path. |
| P8 | Frontend phasing | **Emit `viewer-config.json` immediately** (no bundler needed). The full SSG `index.html` + vendored embed waits on the bundler work the roadmap already flags (§3.3). | Decouples the high-value producer contract from the not-yet-present bundling infra; React tier already consumes the config. |
| P9 | Catalog | A `[overlay].catalog` path is **copied/validated into the dataset dir** on every build (real or synthetic), normalized to the M3 catalog CSV schema. | Gives overlays a producer story on real data; removes the synthetic-only special case. |
| P10 | Path versioning & immutability | **Adopt content/build versioning** so the large `.fits.fz` level files live at stable, content-addressed paths and can be served `Cache-Control: immutable`. The small index files (`*/manifest.json`, `dataset.json`, `catalog.csv`, `viewer-config.json`) are the **mutable pointers** (`no-cache` + `ETag`). *Until versioning lands, every file uses `no-cache` + ETag revalidation* (the policy the demo middleware already ships). | `immutable` is what removes the per-hit revalidation round-trip on the bandwidth-dominant tiles; it is only sound if the path's bytes never change. Today `build_pyramid` overwrites `{stem}_z{z}.fits.fz` **in place** (`demo/vite.config.ts:68-70` notes "production uses immutable + versioned paths" — the intended end state, not yet built). |
| P11 | Deploy artifacts & cache single-source | The deploy artifacts follow a **three-tier taxonomy — generated / placeholder / guide** — and a **single machine-readable cache policy** (`cache-policy.json`) is the source of truth that every per-host config (R2/S3 upload metadata, nginx, Apache, Cloudflare) is *rendered from*. The CLI ships tested templates + script logic in the package and emits only build-specific data (`fitsgl deploy --emit`). | Makes correct, range-serving, cache-optimized deploy the default path rather than tribal knowledge; one cache value in one place can't drift across four configs. (Adapted from the deploy-directory design review.) |
| P12 | Post-deploy verification | Ship a generated **`verify.sh` contract checker** that asserts the deployed host's behavior: tile range → `206` + `Accept-Ranges: bytes`; tile carries the immutable header, index files `no-cache`; CORS exposes the expected headers; (Cloudflare) a second fetch returns `CF-Cache-Status: HIT`. Complements `fitsgl serve` (P6): serve verifies **locally pre-deploy**, `verify.sh` verifies the **real host post-deploy**. | The client cannot distinguish a warm edge HIT from a silent origin range-forward; an explicit external check is the only way to prove the contract on the real CDN. |

**Left open:** the exact `fitsgl.toml` schema version & migration policy; whether
`init` is interactive or batch (lean: batch with sensible detection, `--interactive`
opt-in); the R2/S3 auth surface (env vars vs. config vs. `rclone`); whether `serve`
is Python (stdlib Range handler) or reuses the Vite middleware; the **shape of the
build-id versioning** in P10 (a `<build-id>/` path segment with the manifest as the
mutable pointer into it, vs. a per-file content hash in the filename); whether the
client should **harden the 206 check to validate `Content-Range`** (which would make
CORS `Expose-Headers` load-bearing — see §9.3).

---

## 4. The config file (`fitsgl.toml`)

The producer's single source of truth. Detected/scaffolded by `fitsgl init`,
consumed by `fitsgl build`.

```toml
[dataset]
name  = "cosmos-web"          # stable machine key; output dir + URL slug
title = "COSMOS-Web JWST"     # human label, templated into the page

# Each band is one mosaic → one pyramid. `role` (optional) assigns the default
# R/G/B composite; reddest filter → red is a sensible init default.
[[bands]]
name  = "f444w"
input = "mosaics/cosmos_f444w.fits"
role  = "r"
[[bands]]
name  = "f277w"
input = "mosaics/cosmos_f277w.fits"
role  = "g"
[[bands]]
name  = "f150w"
input = "mosaics/cosmos_f150w.fits"
role  = "b"

[build]
quantize_level = 8            # passes through to build_pyramid
tile_size      = 256
processes      = 0            # 0 = auto (one per level, capped at cpu count)

[overlay]
catalog = "catalogs/sources.csv"   # ra/dec (or x/y) + properties; M3 schema

[view]                         # serialized into viewer-config.json (P4)
stretch  = "asinh"             # linear | asinh | log (StretchMode)
colormap = "gray"             # ColormapName; ignored when RGB roles are set
north_up = true

[deploy]
target = "r2://my-bucket/cosmos-web"   # or "s3://…", or a local/rsync path
```

Mapping to existing code:

- `[[bands]].input` + `[build]` → `build_pyramid(input, …, quantize_level,
  tile_size, processes)` per band.
- `[[bands]].name` + `.role` → `build_dataset([(name, manifest_path), …],
  default_rgb={role: name})` → `dataset.json`.
- `[overlay].catalog` → validated/copied via `catalog.write_catalog_csv`-grade
  normalization → `catalog.csv`.
- `[view]` → the `stretch`/`view.colormap`/`northUp` fields of
  `viewer-config.json` (a `ViewerConfig`).
- `[deploy].target` → `fitsgl deploy`.

A single-band dataset is the degenerate case: one `[[bands]]` entry, no roles, no
`dataset.json` required (the page can load `manifest.json` directly, as the demo's
fallback already does).

---

## 5. Command surface

```
fitsgl init      [DIR]                 # detect *.fits, group by grid, scaffold fitsgl.toml
fitsgl build     [-c fitsgl.toml] [-o dist/]   # build the whole dataset directory
fitsgl serve     dist/<name>/          # local Range-capable preview server (P6)
fitsgl deploy    dist/<name>/ [--target …]     # upload to R2/S3 or print rsync (P7)
```

- **`init`** reads each FITS WCS, groups bands by shared grid (reuse `dataset.grid_hash`
  as the grouping hint), guesses roles from filter-like names, and writes a
  starter `fitsgl.toml` the user edits. Batch by default; `--interactive` to prompt.
- **`build`** is the heart (P1/P5). In-process, no heredocs: per-band
  `build_pyramid`, then `build_dataset`, then catalog normalization, then emit
  `viewer-config.json`, then (when the bundler tier lands, P8) the SSG page +
  embed bundle. Re-runnable; cleans stale level files like the demo script does.
- **`serve`** mounts `dist/<name>/` behind a faithful 206/Range emulation so
  "looks right locally → looks right on the CDN." Mirrors `demo/vite.config.ts`.
- **`deploy`** copies the directory. For a plain webserver it can simply print the
  `rsync` line; for R2/S3 it uploads and sets `Content-Type` (`.fits.fz`) +
  long-lived immutable cache headers (level files are content-stable per build).

`python -m pyramid_gen` remains as the documented low-level primitive for users who
want one pyramid and nothing else.

---

## 6. Output directory layout (P3)

`fitsgl build -o dist/` produces one self-contained, deployable directory:

```
dist/cosmos-web/
├── f444w/
│   ├── f444w_z0.fits.fz … f444w_zN.fits.fz
│   └── manifest.json
├── f277w/ …
├── f150w/ …
├── dataset.json          # band grouping + default_rgb (dataset.build_dataset)
├── catalog.csv           # overlay markers (M3 schema)
├── viewer-config.json    # the ViewerConfig — single source of truth for the view
├── index.html            # SSG page (P8; after the embed-bundle tier lands)
├── fitsgl.embed.js       # vendored, version-pinned vanilla bundle (P8)
└── deploy/               # optional: rendered upload scripts + cache/CORS configs + verify.sh (§9)
```

The whole directory is static. Deployment is copying it to any Range-capable host.

`viewer-config.json` is literally a `ViewerConfig`:

```jsonc
{
  "bands": [
    { "name": "f444w", "tiles": ["f444w/manifest.json"] },
    { "name": "f277w", "tiles": ["f277w/manifest.json"] },
    { "name": "f150w", "tiles": ["f150w/manifest.json"] }
  ],
  "view":    { "mode": "rgb", "r": "f444w", "g": "f277w", "b": "f150w" },
  "stretch": { "mode": "asinh" },
  "northUp": true,
  "overlay": { "url": "catalog.csv" }
}
```

Band `tiles` is a length-1 list now; the `tiles[]` shape is already baked in for
the M6 tiled-mosaic case (roadmap D14), so a large field will need no config
change.

---

## 7. The two front-end doors (same dataset)

Once the directory is on a Range host, both frontends read the *same* files:

- **"I just want a webpage" → the SSG `index.html`** in the deployed dir. Zero JS
  written; it `mount`s the vanilla embed against `viewer-config.json`. *Blocked on
  the bundler/embed tier (P8, roadmap §3.3).* Until then, `build` still emits
  `viewer-config.json`, and the existing `demo`/`demo-react` can point at it.
- **"I have a React app" (e.g. CAMPFIRE) → `npm i fits-pyramid`**, then feed the
  deployed config to the shipped component:
  ```tsx
  import { FitsViewer } from 'fits-pyramid/react';
  const config = await fetch('https://…/cosmos-web/viewer-config.json').then(r => r.json());
  <FitsViewer config={config} /* + imperative handle for live markers */ />
  ```
  This tier exists today (`fits-pyramid/src/react/index.tsx`).

Both consume the producer's emitted contract — the discipline that keeps the tiers
from diverging (roadmap §3.5).

---

## 9. Deployment artifacts, cache policy & CORS

`fitsgl deploy` makes a correct, range-serving, cache-optimized deploy the
*default path* — while keeping a CDN an **optional accelerator, not a dependency**
(a plain university static-file host works; you lose only edge caching). It does
this by emitting a `deploy/` artifact set, driven by one cache policy, with a
post-deploy verifier. (Adapted from the deploy-directory design review; corrected
against the actual client and layout.)

### 9.1 Three-tier config taxonomy (P11)

Every deploy artifact is exactly one of:

1. **Generated** — values the tool knows: cache `max-age`, which paths are
   immutable, the file list + class, CORS expose-headers. The user never edits
   the values.
2. **Placeholder** — identifiers the user supplies once, in a single
   `config.example.env`: bucket, account/endpoint, viewer origin (CORS),
   credentials. Never hardcoded into individual scripts, never committed with real
   values.
3. **Guide** — one-time account actions that can't be scripted from an install:
   creating the bucket, plan-gated Cloudflare features (Cache Reserve / tiered
   cache), DNS / custom domain. Shipped as docs + optional Terraform the user
   applies with their own credentials.

### 9.2 Cache policy — two file classes, one source of truth (P10/P11)

`cache-policy.json` is the single machine-readable source; every per-host config is
rendered from it (don't hand-maintain the same `max-age` in four files). In a
FitsGL **dataset** (not a single pyramid) the two classes are:

| Class | Matches | `Cache-Control` | Why |
|---|---|---|---|
| **Immutable asset** | the large `.fits.fz` level files, **once at versioned/content-addressed paths** (P10) | `public, max-age=31536000, immutable` | content never changes at that path → no revalidation round-trip on a hit (the bandwidth win) |
| **Mutable pointer** | *all* small index files: every `*/manifest.json`, `dataset.json`, `catalog.csv`, `viewer-config.json` | `public, no-cache` (+ `ETag`) | the only things a rebuild changes; must revalidate so new builds are picked up |

> **Correction vs. the source report.** That report assumed a single
> `./pyramid/manifest.json` as the lone mutable pointer and `…/<build-id>/…/*.fits.fz`
> versioned tiles. A FitsGL dataset has **several** mutable index files (above), and
> **`build_pyramid` does not emit versioned paths today** — it overwrites
> `{stem}_z{z}.fits.fz` in place. So `immutable` is **gated on P10**. Until build-id
> versioning lands, the rendered policy is `no-cache` + `ETag` for *every* file —
> exactly what `demo/vite.config.ts` already serves — which is correct but pays a
> revalidation round-trip per tile hit.

### 9.3 CORS — needed, but for the right reason (corrected)

A cross-origin upload sets CORS. Ship a `cors.json` like:

```json
{ "AllowedOrigins": ["${VIEWER_ORIGIN}"], "AllowedMethods": ["GET","HEAD"],
  "AllowedHeaders": ["Range"],
  "ExposeHeaders": ["Content-Range","Content-Length","Accept-Ranges","ETag","Age","CF-Cache-Status"],
  "MaxAgeSeconds": 86400 }
```

**Accuracy note.** The source report claimed the client *requires* `Content-Range`
exposed to validate the 206. It does **not**: `httpRangeFetch`
(`fits-pyramid/src/fpack/fpack-file.ts:41-52`) validates by `resp.status === 206`
(rejecting 200) and reads the body directly; nothing in the TS source reads
`Content-Range`/`ETag`/`CF-Cache-Status`. So `Allow-Origin` alone makes the core
fetch work cross-origin. `Expose-Headers` is for **observability** (a debug HUD
reading `CF-Cache-Status`/`Age` to prove edge HITs) and **future-proofing** — it
becomes load-bearing only if we harden the 206 check to validate `Content-Range`
(an open item, §3). Shipping the expose list defensively is still right; the
rationale is observability, not basic function.

**Viewer origin default.** For public science pyramids, default `VIEWER_ORIGIN` to
`*` with a documented override (locking to one origin is the opt-in). `*` blocks
credentialed requests, which is irrelevant here — tiles are public, unauthenticated.

### 9.4 Generated `deploy/` layout

```
deploy/
  README.md                 [guide]        pick-your-target walkthrough; auto vs one-time
  config.example.env        [placeholder]  the ONE file of identifiers
  cache-policy.json         [generated]    source of truth: path-class → headers
  deploy-manifest.json      [generated]    every output path + its class
  verify.sh                 [generated]    post-deploy contract checker (P12)
  object-storage/
    r2/   upload.sh, cors.json             [generated]  two-pass sync, correct Cache-Control per class
    s3/   upload.sh, cors.json, bucket-policy.example.json
  static-server/
    nginx/fitsgl.conf, apache/.htaccess    [generated]  Cache-Control + Accept-Ranges + CORS
  cloudflare/
    README.md                              [guide]      account steps; free vs plan-gated
    terraform/ main.tf, terraform.tfvars.example        cache rules + Cache Reserve as code
```

`upload.sh` is a **two-pass** sync because object storage sets `Cache-Control` as
per-object metadata at upload: pass 1 syncs the immutable assets, pass 2 re-puts the
mutable index files with `no-cache`, then applies `cors.json`. Generation strategy
(P11): templates + verifier logic live versioned/tested in the package; the build
emits only the build-specific data (`cache-policy.json`, `deploy-manifest.json`, a
fresh `config.example.env`). `fitsgl deploy --emit` renders concrete per-host
configs into the dataset dir for hand-off to an ops person who shouldn't need the
package installed.

### 9.5 `verify.sh` — the "did it actually work" gate (P12)

Run in CI against staging and on first production load. Against a deployed base URL
it asserts: a tile range request returns **`206`** + **`Accept-Ranges: bytes`**; the
tile carries the **immutable** header while index files carry `no-cache`; with an
`Origin` header the response exposes the CORS headers; and (Cloudflare) a **second**
fetch returns **`CF-Cache-Status: HIT`**, proving the edge cached the large object
instead of range-forwarding to origin. This is the only external check that
distinguishes a warm edge from a silent origin bypass — the client can't tell.

---

## 10. Phasing

1. **`fitsgl build` from `fitsgl.toml`** (P1/P2/P5) — the highest-leverage slice:
   moves the demo's heredoc orchestration into a real, testable command and gives a
   producer a one-command multi-band dataset. Emits `dataset.json`, `catalog.csv`,
   and `viewer-config.json`. No bundler, no renderer change.
2. **`fitsgl serve`** (P6) — promote the Range middleware; lets a producer verify
   before deploying.
3. **`fitsgl init`** (scaffold) — convenience on top of (1).
4. **`fitsgl deploy` + the `deploy/` artifacts** (P7/P11/P12, §9) — R2/S3 upload
   with correct per-class headers, rendered per-host configs, CORS, and the
   `verify.sh` contract checker. Ships first with `no-cache` + ETag for every file
   (works immediately); the `immutable` tile policy unlocks once **path versioning**
   (P10) lands, which can be sequenced independently as a `build_pyramid` change.
5. **SSG page + vanilla embed** (P8) — gated on the bundler infra the roadmap
   already calls out (§3.3); turns the output dir into a zero-JS website.

Steps 1–4 need no new browser code and no bundler; they make the *producer* journey
coherent on top of the existing primitive. Step 5 completes the self-serve story.
