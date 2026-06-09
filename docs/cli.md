# FitsGL producer CLI

`fitsgl` turns FITS mosaics into a self-contained, browser-native viewer you can
host anywhere. It builds a multi-resolution tile pyramid (one fpacked `.fits.fz`
per supertile per level), emits a viewer (`index.html` + assets), and —
optionally — pushes the whole thing to Cloudflare R2 behind a CDN.

This is a how-to for the `fitsgl` command. It assumes you are comfortable with
the shell and with FITS; web-hosting concepts are explained in plain language
where they come up.

## Install

```bash
cd fitsgl-py
pip install -e .            # build + serve + verify
pip install -e ".[deploy]"  # also `fitsgl deploy` (pulls in boto3)
pip install -e ".[test]"    # dev: pytest
```

`deploy` is an optional extra so a build-only install stays lean. If you run
`fitsgl deploy` without it, you get a pointed `pip install 'fitsgl[deploy]'`
error.

Two console scripts are installed:

- `fitsgl` — the producer pipeline (this guide). Subcommands: `init`, `build`,
  `demo`, `serve`, `verify`, `deploy`, `index`.
- `fitsgl-gen` (also `python -m fitsgl`) — the low-level single-pyramid
  primitive. See [Low-level primitive](#low-level-primitive-fitsgl-gen) at the
  end. Most users never need it.

## Quickstart

Fastest path to seeing something — a synthetic dataset, built and served:

```bash
fitsgl demo --serve
# open the printed http://localhost:8000/ URL
```

The real path, FITS mosaics → published viewer:

```bash
fitsgl init                 # scan the cwd, scaffold a fitsgl.toml
$EDITOR fitsgl.toml         # review bands, set the default view, add a catalog
fitsgl build                # -> dist/<name>/  (data + viewer)
fitsgl serve dist/<name>    # preview locally with HTTP Range support
fitsgl deploy               # push to Cloudflare R2 + purge the CDN edge
```

## What `build` produces

`fitsgl build` writes one self-contained dataset directory at
`dist/<dataset.name>/`:

- one subdirectory per band, each holding its level files (`z<level>` supertile
  `.fits.fz` files) and a `manifest.json`;
- `catalog.csv` if you configured a catalog overlay;
- `fitsgl.json` — the viewer's entry point and the "dataset is complete" marker;
- `index.html` + `assets/` — the bundled viewer (skipped with `--no-site`).

The build is **resumable**: each band is promoted into the dataset the instant it
finishes, so a cancelled or crashed build keeps every completed band, and a
re-run skips them. Reuse keys on a band's *presence*, not the parameters it was
built with — so after changing a `[build]` knob you must pass `--overwrite` to
force a clean rebuild. `fitsgl.json` and the viewer are always re-emitted.

Every level is a **display-only** product: `RICE_1`, `quantize_level=8`,
`SUBTRACTIVE_DITHER_2` — lossy but photometry-faithful to ~0.03%. Ship your raw
lossless mosaic separately; this pipeline does not.

## Command reference

### `fitsgl init`

Scan a directory of FITS mosaics and scaffold a `fitsgl.toml`. Reads headers only
(no pixels), detects HST/JWST filters where possible, groups bands by WCS grid
(co-gridded bands are RGB-combinable), and auto-picks a default view (RGB when ≥3
co-gridded broadbands are found, else single-band).

| Flag | Default | Meaning |
| --- | --- | --- |
| `dir` (positional) | `.` | Directory to scan. |
| `--force` | off | Overwrite an existing `fitsgl.toml`. |

```bash
fitsgl init data/cosmos/
```

The scaffold is the review surface: it comments the grid groups so you can see
which bands compose, and includes a commented-out `[deploy]` stub. Edit it, then
`fitsgl build`.

### `fitsgl build`

Build a dataset directory from a `fitsgl.toml` (or a whole workspace with `-w`).

| Flag | Default | Meaning |
| --- | --- | --- |
| `-c, --config` | `./fitsgl.toml` | Single config. Mutually exclusive with `-w`. |
| `-w, --workspace` | — | Build every `[[field]]` in a `fitsgl.workspace.toml`. |
| `--field NAME` | all | With `-w`: build only this field (by prefix; repeatable). |
| `-o, --out` | `./dist` | Output root; dataset lands in `<out>/<dataset.name>/`. |
| `-p, --processes` | auto | Worker processes for level building. |
| `--no-verify` | off | Skip the per-level read-back check (a second full decode/level). Use for huge mosaics where memory is tight. |
| `--overwrite` | off | Rebuild every band from scratch (needed after changing a `[build]` knob). |
| `--no-site` | off | Write data + `fitsgl.json` only; skip the bundled viewer. |
| `--site-only` | off | Re-emit only the viewer into an already-built dataset (fast refresh). |

`-c` and `-w` are mutually exclusive; `--field` only applies with `-w`.

```bash
fitsgl build                      # ./fitsgl.toml -> dist/<name>/
fitsgl build -o build/ --overwrite
fitsgl build --site-only          # just refresh index.html + assets/
```

### `fitsgl demo`

Generate a synthetic dataset, build it (data + viewer), and optionally serve it.
Good for a smoke test or to see the viewer without your own data.

| Flag | Default | Meaning |
| --- | --- | --- |
| `-o, --out` | `./dist` | Output root; dataset lands in `<out>/<name>/`. |
| `--name` | `demo` | Dataset name = output subdirectory. |
| `--size` | `512` | Square mosaic edge length (pixels). |
| `--no-catalog` | off | Skip the overlay marker catalog. |
| `--serve` | off | Serve over HTTP once built (blocks until Ctrl-C). |
| `-p, --port` | `8000` | Port for `--serve` (`0` = pick a free port). |
| `--processes` | auto | Worker processes. |
| `--no-verify` | off | Skip per-level read-back verification. |

```bash
fitsgl demo --serve --size 2048
```

### `fitsgl serve`

Serve a built dataset directory over HTTP **with byte-range support**. This is
the local-preview server; it implements the same host contract `verify` checks
(so it doubles as the reference for what a real host must do).

> Plain-language note: a browser FITS viewer fetches small *ranges* of large
> files (HTTP `Range` requests). A plain static server that ignores `Range` and
> returns the whole file breaks the viewer. `fitsgl serve` does it right; many
> naive `python -m http.server`-style servers do not.

| Flag | Default | Meaning |
| --- | --- | --- |
| `dataset_dir` (positional) | — | Directory to serve, e.g. `dist/<name>`. |
| `-p, --port` | `8000` | Port (`0` = pick a free port). |

```bash
fitsgl serve dist/cosmos
```

### `fitsgl verify`

Check a **deployed** dataset URL against the host contract (Range / MIME / CORS)
by fetching its own files and reading the response headers — something a browser
can't fully do because of cross-origin limits, so this is the authoritative
probe.

Severity is tiered: correctness checks (Range→`206`, MIME types, `fitsgl.json`
loads, the CORS preflight) **fail** the command; perf checks (cold edge cache,
oversized objects) only **warn**.

| Flag | Default | Meaning |
| --- | --- | --- |
| `url` (positional) | — | Base URL where the deployed `fitsgl.json` lives. |
| `--origin` | — | Also assert the cross-origin CORS preflight for an embedder at this site (e.g. `https://campfire.example`). |
| `--strict` | off | Promote warnings to failures (for CI). |

```bash
fitsgl verify https://data.example.org/cosmos
fitsgl verify https://data.example.org/cosmos --origin https://campfire.example --strict
```

### `fitsgl deploy`

Push a built dataset (or a whole workspace with `-w`) to Cloudflare R2 and purge
the CDN edge. Requires a `[deploy]` table in the config and the `fitsgl[deploy]`
extra; the dataset must already be built (a `fitsgl.json` must exist under
`<out>/<name>/`). See [Deploy](#deploy) below.

| Flag | Default | Meaning |
| --- | --- | --- |
| `-c, --config` | `./fitsgl.toml` | Single config. Mutually exclusive with `-w`. |
| `-w, --workspace` | — | Deploy every `[[field]]` plus the collection landing page. |
| `--field NAME` | all | With `-w`: deploy only this field (by prefix; repeatable). |
| `-o, --out` | `./dist` | Output root holding `<dataset.name>/`. |
| `--dry-run` | off | Print the upload/delete/purge plan; write nothing. |
| `--no-verify` | off | Skip the post-deploy contract check against the live URL. |
| `--site-only` | off | Push only the viewer; leave the data + its ledger untouched. |
| `--yes` | off | Skip the upload confirmation prompt (for CI). |
| `-j, --concurrency` | `[deploy].concurrency` or 8 | Parallel upload streams to R2. |
| `--env-file` | `.env` next to the config | Read R2/Cloudflare secrets from this file. |

```bash
fitsgl deploy --dry-run          # preview the plan
fitsgl deploy                    # push, confirm, then purge + verify
```

Only changed files are uploaded (it diffs against a ledger stored in the bucket).
`--concurrency` only trades wall-clock for connections; the set of files sent is
the same.

### `fitsgl index`

Emit the collection landing page (`collection.json` + a picker viewer) for a
workspace — the page that lists all your fields. Normally a full `fitsgl deploy
-w` refreshes and deploys this for you; run `index` to regenerate it locally or
after a subset deploy.

| Flag | Default | Meaning |
| --- | --- | --- |
| `-w, --workspace` | `./fitsgl.workspace.toml` | The workspace file. |
| `-o, --out` | `./dist` | Output root holding the built field dirs. |

```bash
fitsgl index -w fitsgl.workspace.toml
```

## `fitsgl.toml`

One file describes a whole multi-band dataset. It is split into `[dataset]` (what
data exists — pure inventory), `[viewer]` (the *initial* view; everything is
overridable live in the viewer), `[build]` (compression/tiling knobs), and an
optional `[deploy]` (hosting target). Note the block is `[viewer]`, not `[view]`.

```toml
[dataset]
name = "cosmos"                  # required; the on-disk dir + URL slug
title = "COSMOS-Web"             # optional human title
catalog = "sources.csv"          # optional ra/dec (or x/y) CSV overlay, relative to this file

# Each band is one [[dataset.bands]]. `name` is a URL/dir-safe slug; `input` is
# one mosaic, a list of pre-tiled tiles, or a glob (expanded sorted). Reserved
# names are refused: dataset, catalog, fitsgl, index, assets, deploy, embed, collection.
[[dataset.bands]]
name = "f444w"
label = "F444W"                  # optional display label (defaults to `name`)
input = "mosaics/cosmos_f444w.fits"

[[dataset.bands]]
name = "f277w"
label = "F277W"
input = "mosaics/cosmos_f277w.fits"

[[dataset.bands]]
name = "f150w"
label = "F150W"
input = "mosaics/cosmos_f150w_*.fits"   # glob: several pre-tiled tiles onto one grid

[build]
quantize_level = 8               # RICE_1 quantization (default 8; display-only)
tile_size = 256                  # fpack-internal tile size (default 256)
# supertile_blocks = 48          # render-tiles per side per .fits.fz file (default 48)

[viewer]
default = "rgb"                  # "single" | "rgb"
r = "f444w"                      # required when default = "rgb"
g = "f277w"
b = "f150w"
stretch = "asinh"                # linear | log | asinh | trilogy
# band = "f444w"                 # for default = "single" (optional; else first band)
# colormap = "viridis"          # single-band only
# north_up = true               # boolean
```

Key notes, verified against the parser:

- `[viewer].default` selects the mode; `r`/`g`/`b` are required for `rgb`, `band`
  is optional for `single` (defaults to the first band). View keys reference a
  band's `name` (or its original toml name) and must resolve to a known band.
- `[viewer].stretch` must be one of `linear | log | asinh | trilogy`. `colormap`
  applies to single-band mode only.
- `[build]` keys are all integers; `quantize_level` and `tile_size` must be
  positive, `supertile_blocks ≥ 1`. Changing any of these requires `fitsgl build
  --overwrite`.
- A `name` that isn't URL-safe is slugged automatically (with a warning unless
  you set an explicit `label`).

### `[deploy]` (single dataset)

```toml
[deploy]
target = "r2"                    # only "r2" is supported
bucket = "my-bucket"
endpoint = "https://<account-id>.r2.cloudflarestorage.com"
public_url = "https://data.example.org/cosmos"   # where it is served (your cached custom domain)
zone_id = "<cloudflare-zone-id>" # optional; enables the post-deploy edge purge
prefix = ""                      # optional key prefix within the bucket
viewer_origin = "*"              # CORS Allow-Origin for cross-site embedding
tile_max_age = 604800            # seconds the edge serves a tile before revalidating (default 7d)
concurrency = 8                  # parallel upload streams (default 8; --concurrency overrides)
```

`bucket`, `endpoint`, and `public_url` are required; the rest are optional.
**Secrets never go in this file** — `fitsgl deploy` reads `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, and (for the purge) `CLOUDFLARE_API_TOKEN` from the
environment or a git-ignored `.env` next to the config. Real environment
variables win over the `.env`. Without `zone_id` + a token, the edge purge is
skipped.

## Multiple fields (workspace)

A workspace publishes many datasets (fields) into **one R2 bucket**, each under
its own key prefix, plus a landing page that lists them. `fitsgl.workspace.toml`
references **existing** per-field `fitsgl.toml` files — it never inlines a
dataset.

```toml
[workspace]
name = "surveys"
title = "My Surveys"

# Shared deploy target. Note: base_url (NOT public_url), and NO prefix here —
# both are per-field and derived. Each field's served URL = base_url/<prefix>.
[deploy]
target = "r2"
bucket = "my-bucket"
endpoint = "https://<account-id>.r2.cloudflarestorage.com"
base_url = "https://data.example.org"
zone_id = "<cloudflare-zone-id>"   # optional; enables the edge purge
viewer_origin = "*"
tile_max_age = 604800
concurrency = 8

# Optional landing-page header (defaults to the [workspace] name/title).
[collection]
name = "surveys"
title = "My Surveys"

[[field]]
config = "cosmos/fitsgl.toml"      # relative to this file; must exist
# prefix = "cosmos"                # default: the child's dataset.name
# title  = "COSMOS-Web"            # default: child title, then child name

[[field]]
config = "uds/fitsgl.toml"
```

How prefixes and URLs are derived (verified against `workspace.py`):

- A field's **prefix** = its `[[field]].prefix` override, else the child's
  `[dataset].name`. The prefix is the bucket key prefix *and* the deploy ledger
  key.
- A field's served **`public_url`** = `base_url` + `/` + prefix
  (slash-normalized). Set `base_url` once and every field's URL follows its
  prefix automatically — no manual sync.
- The collection landing page is written at the bucket root (prefix `""`).

Validation runs before any I/O: each effective prefix must be non-empty, URL/key-
safe (`[A-Za-z0-9_-]`), unique, and not one of the reserved prefixes (`""`, `.`,
`assets`, `index`, `collection`). Child `dataset.name`s must be unique (else two
fields build into the same `dist/<name>/`).

Usage:

```bash
fitsgl build  -w fitsgl.workspace.toml                 # build every field
fitsgl build  -w fitsgl.workspace.toml --field cosmos  # subset (by prefix; repeatable)
fitsgl deploy -w fitsgl.workspace.toml                 # deploy every field + the landing page
fitsgl index  -w fitsgl.workspace.toml                 # just (re)emit the landing page
```

`--field` selectors match a field's effective **prefix**. A full `deploy -w`
refreshes and deploys the landing page only when every selected field's bytes
uploaded (a verify failure does not block it); a subset deploy leaves the landing
page alone (run `fitsgl index` or a full deploy to update it). If a child
`fitsgl.toml` has its own `[deploy]`, the workspace `[deploy]` overrides it under
`-w` (you'll see a note).

## Deploy

`fitsgl deploy` pushes to Cloudflare R2 (object storage) and serves it through
Cloudflare's CDN at your `public_url`. In plain terms:

- **R2** is where the tile files live (like an S3 bucket).
- The **CDN edge** is Cloudflare's global cache in front of R2 — visitors hit a
  nearby cached copy instead of your bucket directly, which is what makes a large
  mosaic feel fast.
- A **purge** tells the edge to drop its cached copy of files you changed so
  visitors get the new ones immediately (push-first, then purge).

One-time setup — bucket, custom domain, CORS, and the `.fits.fz` Cache Rule — is
in **[docs/r2-setup.md](./r2-setup.md)**. Follow that first; this guide doesn't
duplicate it.

Typical flow once set up:

```bash
fitsgl build
fitsgl deploy --dry-run          # see what would change
fitsgl deploy                    # upload changed files, purge, then verify the live URL
fitsgl verify https://data.example.org/cosmos   # re-check a deployed dataset anytime
```

If the post-deploy verify fails but the upload succeeded, the bytes are live —
it's almost always the one-time `.fits.fz` Cache Rule or custom-domain setup.
Re-run `fitsgl verify <public_url>` for per-check detail and consult
[docs/r2-setup.md](./r2-setup.md).

## Low-level primitive: `fitsgl-gen`

`fitsgl-gen` (equivalently `python -m fitsgl`) is **not** the producer pipeline —
it builds a single fpacked `.fits.fz`-per-level pyramid plus a `manifest.json`
from raw mosaic(s), with no `fitsgl.toml`, no multi-band dataset, no viewer, and
no deploy. Most users want `fitsgl build`. Reach for `fitsgl-gen` only when you
need a bare pyramid.

```bash
fitsgl-gen mosaic.fits                              # -> mosaic_pyramid/ beside the input
fitsgl-gen mosaic.fits -o out/ --quantize-level 16
fitsgl-gen --synthetic /tmp/synth.fits             # write a synthetic mosaic, then build it
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `inputs` (positional) | — | One or more FITS mosaics. |
| `-o, --output-dir` | `<stem>_pyramid/` | Output dir (single input only — rejected with multiple inputs). |
| `--tile-size` | 256 | fpack-internal tile size. |
| `--quantize-level` | 8 | RICE_1 quantization (display-only). |
| `--processes` | auto | Worker processes. |
| `--synthetic PATH` | — | Write a synthetic test mosaic to PATH, then build it. |
