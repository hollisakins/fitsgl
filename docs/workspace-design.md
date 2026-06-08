# Workspace design — many fields, one bucket

Status: design locked 2026-06-07 (synthesized from a 5-perspective design pass +
adversarial footgun review). Supersedes nothing; extends `deploy-design.md` and
`supertile-design.md`. Implemented in `fitsgl-py/src/fitsgl/{workspace,collection}.py`,
`cli.py`, and the `viewer/` picker.

## Problem

A producer builds tiles for **multiple fields** (different input directories,
different bands) and wants to deploy them all to **one Cloudflare R2 bucket** under
**different prefixes** (`cosmos/`, `egs/`, `uds/`). Today that means N separate
`fitsgl.toml` files, N duplicated `[deploy]` blocks, N hand-run `build`+`deploy`
invocations, and manually keeping each field's `prefix` and `public_url` in sync.
There is also no landing page tying the fields together.

## Locked decisions

- **Config shape = reference child tomls.** A new `fitsgl.workspace.toml` holds a
  shared `[deploy]` block + a `[collection]` table + a list of `[[field]]` entries,
  each pointing at an **existing** per-field `fitsgl.toml`. Each field stays a
  standalone, independently-buildable dataset. We never inline `[[dataset]]`.
- **Invariant preserved:** one field = one child `fitsgl.toml` = one prefix = one
  ledger (`<prefix>/deploy-manifest.json`). Each field's deploy stays independent
  and incremental. The workspace layer is thin orchestration on top.
- **A — derive prefix/public_url.** A field's `prefix` defaults to its child
  `dataset.name`; its `public_url` is **derived** as `base_url/prefix` from the one
  shared `base_url`. The producer can never make them drift, because both come from
  the single resolved `prefix`.
- **B — orchestration.** `fitsgl build -w ws.toml [--field NAME …]` and
  `fitsgl deploy -w ws.toml [--field NAME …]` loop the fields, delegating to the
  existing `build_dataset()` / `deploy_dataset()`. Bucket CORS is set **once** per
  workspace deploy; the R2 target + Cloudflare purger are constructed **once**
  (shared bucket/zone). Per-field failures are caught and summarized (continue,
  don't abort); exit non-zero if any field failed.
- **C — collection landing page.** `fitsgl index -w ws.toml` emits a root
  `collection.json` + a picker-mode viewer page; a full `fitsgl deploy -w` deploys
  each field then the collection root at bucket prefix `""`. The viewer reuses the
  **same** vendored bundle in picker mode.

## `fitsgl.workspace.toml`

```toml
[workspace]
name  = "campfire"                 # required: workspace identity
title = "Campfire Survey Fields"   # optional

[collection]                       # optional; the landing page header
name  = "campfire"                 # optional, defaults to [workspace].name
title = "Campfire Survey Fields"   # optional, defaults to name

[deploy]                           # SHARED across every field (required for deploy/index)
target   = "r2"                    # optional, must be "r2"
bucket   = "campfire-data"         # required
endpoint = "https://<acct>.r2.cloudflarestorage.com"  # required
base_url = "https://data.example.org"   # required: public_url = base_url/<prefix>
zone_id       = "<zone-id>"        # optional; enables the edge purge
viewer_origin = "*"                # optional; bucket CORS Allow-Origin (set ONCE)
tile_max_age  = 604800             # optional positive int
concurrency   = 8                  # optional positive int

[[field]]
config = "cosmos/fitsgl.toml"      # required: path to an existing per-field toml (rel. to this file)
# prefix = "cosmos"                # optional override; default = child dataset.name
# title  = "COSMOS"               # optional landing-card title; default = child title, else name

[[field]]
config = "egs/fitsgl.toml"
```

Notes:

- The workspace `[deploy]` uses **`base_url`**, not `public_url`, and has **no
  `prefix`** (it is per-field). The parser rejects `public_url`/`prefix` in a
  workspace `[deploy]` with a pointed message, so a copy-pasted per-dataset
  `[deploy]` fails loudly instead of silently doing the wrong thing.
- `swr_grace` stays at the default (it is not a TOML knob in the per-dataset config
  either — parity with `config.DeployConfig`).
- A child toml that *also* carries its own `[deploy]` → **warn and ignore**; the
  workspace `[deploy]` is authoritative (so a standalone field can be reused as-is).

## Identity, derivation, and the cheap peek

A field has two identities, both derived from the **single** resolved prefix:

- **deploy identity** = `prefix` (override, else child `dataset.name`) → the bucket
  key prefix, the ledger key, and the URL path segment.
- **display identity** = `title` (override, else child `title`, else `dataset.name`).

```python
field_prefix(ref, child)      = ref.prefix or child_dataset_name
field_public_url(ws, prefix)  = f"{ws.deploy.base_url.rstrip('/')}/{prefix.strip('/')}"
field_deploy_config(ws, ref, child_name) -> DeployConfig(
    bucket/endpoint/zone_id/viewer_origin/tile_max_age/swr_grace/concurrency = shared,
    prefix      = field_prefix(...),
    public_url  = field_public_url(...),   # cannot drift: both from one prefix
)
```

**Cheap peek.** Computing a field's default prefix needs the child `dataset.name`,
but `load_config()` is eager — it stats every band's FITS input. A subset build
(`--field cosmos`) must not require *every* field's inputs to exist (they may live
on another machine). So `config.read_dataset_name(path)` parses only
`[dataset].name` (no input resolution). The CLI uses it to (a) resolve `--field`
selectors, (b) validate global uniqueness across **all** fields, and (c) default
prefixes — all without statting any FITS. The eager `load_config()` runs only for
the **selected** fields, at build/deploy time.

`--field NAME` matches a field's **prefix** (= `dataset.name` by default).

## Validation (footgun mitigations)

Enforced before any filesystem/network writes:

| Rule | Why (failure it prevents) |
| --- | --- |
| `[workspace].name` required; ≥1 `[[field]]` | basic schema |
| each `[[field]].config` exists; child paths unique | typo / double-reference |
| workspace `[deploy]` rejects `public_url` and `prefix` | copy-pasted per-dataset block |
| `base_url` required iff `[deploy]` present | build-only workspaces need no deploy |
| **prefix is slug-safe, non-empty, not reserved** | a `""`/`.` prefix collides with the collection root's `index.html` + the root ledger `deploy-manifest.json` at prefix `""` |
| **effective prefixes unique across fields** | two fields sharing a prefix share a ledger → each deploy sees the other as "remote" and `diff.delete` purges the other's tiles |
| **child `dataset.name` unique across fields** | two fields build into the same `out/<name>/` (clobber) and default to the same prefix |
| `--field NAME` must name a known field | silent no-op on a typo |

`RESERVED_FIELD_PREFIXES = {"", ".", "assets", "index", "collection"}` — each
collides with a root-level object the collection deploy writes. Prefix must equal
`slugify_band_name(prefix)` (one clean URL/key segment, no slashes). `"collection"`
is also added to `RESERVED_BAND_NAMES` to future-proof the root contract.

**Known v1 limitation (documented, not coded):** removing a `[[field]]` from the
workspace leaves that prefix's objects + ledger orphaned in the bucket (per-field
deploys are independent and have no global view). A `--prune-removed-fields` pass is
a future add-on; for now the dropped field simply disappears from the picker while
its bytes linger. Re-running `deploy -w` from a machine with all fields built is the
safe path.

## Collection landing page (C)

### `collection.json` (root, bucket prefix `""`)

```json
{
  "schemaVersion": 1,
  "collection": { "name": "campfire", "title": "Campfire Survey Fields" },
  "fields": [
    { "name": "cosmos", "title": "COSMOS", "bandCount": 7,
      "center": { "ra": 150.116, "dec": 2.201 } },
    { "name": "egs", "title": "EGS", "bandCount": 5 }
  ]
}
```

- `name` == the field's **deploy prefix**, so the picker card links to `${name}/`
  (a sibling subdir under the deploy root).
- Everything past `name`/`title` is **best-effort**, read from each field's already
  built `out/<name>/fitsgl.json` (`bandCount` = `len(dataset.bands)`) and its first
  band's `manifest.json` z=0 WCS (`center` = `CRVAL`, a cheap field-center proxy).
  A field with an unreadable manifest still appears, just without `center`.
- A field whose `out/<name>/fitsgl.json` is missing (not built) is skipped with a
  warning — the collection lists only built fields.

### Dotdir staging — the clean root deploy

The collection root is staged at **`out/.collection/`** (`collection.json` +
`index.html` + `assets/` via the same `copy_viewer_into`). Deploying it points
`deploy_collection_root(out, …)` at `out/.collection/` with `prefix=""`:

- It is a **small** dir (no field subdirs) → `build_deploy_manifest`'s `rglob` never
  walks the whole multi-field tree. No double-upload, no `include` predicate needed.
- The leading dot means `_iter_dataset_files` (which skips dot-segments) and
  `_prune_orphan_bands` (which skips dotdirs) both ignore it elsewhere — it can never
  be mistaken for a field or accidentally swept.
- The one required change to `build_deploy_manifest`: relax its gate to accept
  **`fitsgl.json` OR `collection.json`** (the root has the latter, not the former).

At deploy, `.collection/`'s files upload to prefix `""` → `collection.json`,
`index.html`, `assets/*` land at the bucket root. The root gets its own ledger at
`deploy-manifest.json` (prefix `""`), isolated from every field's
`<prefix>/deploy-manifest.json`. Its `diff.purge` is always empty (`index.html`/
`collection.json` are `no-cache` pointers, `assets/*` are immutable-hashed, no
tiles), and `run_verify=False` (the field deploys verify the data contract; the
root has no `fitsgl.json` for the current verifier).

### Viewer picker mode (one bundle, both roles)

`viewer/src/App.tsx` probes `collection.json` at `document.baseURI` first; if it
loads, render `<CollectionPicker>`; otherwise fall back to today's
`loadFitsglConfig('fitsgl.json')`. A field dir has no `collection.json` (404 →
field) and the collection root has no `fitsgl.json` — mutually exclusive by
construction, first-match wins.

This means **`site.copy_viewer_into` is unchanged** and the **same** vendored bundle
serves both a field dataset dir and the collection root. New files
(`collection.ts`, `CollectionPicker.tsx`) live under `viewer/src/**`, which the
staleness gate (`test_vendored_viewer_is_fresh`) already hashes — so the only extra
step is the usual `npm --prefix viewer run build-vendor` + commit the rebuilt
`_viewer/`. `collection.json` carries its own `COLLECTION_SCHEMA_VERSION`, decoupled
from `FITSGL_SCHEMA_VERSION`.

## CLI surface

```bash
fitsgl build  -w ws.toml [--field cosmos ...] [-o out] [-p N] [--overwrite] [--no-site|--site-only] [--no-verify]
fitsgl index  -w ws.toml [-o out]                       # emit out/.collection/ from built fields
fitsgl deploy -w ws.toml [--field cosmos ...] [-o out] [--dry-run] [--yes] [--site-only] [-j N] [--env-file F] [--no-verify]
```

- `-w/--workspace` and `-c/--config` are a mutually-exclusive argparse group on
  `build`/`deploy`; `-o`, `-p`, etc. are shared. A bare `fitsgl build` (no `-w`) is
  byte-for-byte the existing single-dataset path.
- **build loop:** for each selected field, `load_config(child)` →
  `build_dataset(child, out, …)` (per-field dir `out/<child.name>/`, unchanged).
  Continue-and-summarize; exit 1 if any field failed.
- **deploy loop:** `.env` resolved once (workspace dir); `R2Target`/`CloudflarePurge`
  built once from the shared `[deploy]`; **CORS set once** before the loop; each
  field → `deploy_dataset(out/<name>, field_deploy_config(...), target, set_cors=False, …)`.
  A **full** deploy (no `--field`) then regenerates `out/.collection/` from all built
  fields and calls `deploy_collection_root`. A subset deploy leaves the collection
  root untouched (so it can't drop a field that wasn't rebuilt locally) and prints a
  note to run `fitsgl index` / a full deploy to refresh it.
- Per-field confirmation reuses the existing prompt (no-op fields don't prompt);
  `--yes` suppresses all.

## Code changes (summary)

- `config.py`: `read_dataset_name()` peek; `"collection"` → `RESERVED_BAND_NAMES`.
- `workspace.py` (new): dataclasses + `load_workspace`, `_parse_workspace_deploy`,
  `_parse_collection`, derivation helpers, `validate_workspace_fields`,
  `select_fields`, `RESERVED_FIELD_PREFIXES`.
- `collection.py` (new): `build_collection()` (pure) + `write_collection()`.
- `deploy_plan.py`: gate accepts `fitsgl.json` OR `collection.json`.
- `deploy.py`: `deploy_dataset(..., set_cors=True)` + guard; `deploy_collection_root()`.
- `cli.py`: `-w`/`--field` on `build`/`deploy`, `index` subcommand, handlers, dispatch.
- `viewer/src`: `collection.ts`, `CollectionPicker.tsx`, `App.tsx`, `styles.css`,
  `collection.test.ts`; re-vendor `_viewer/`.
```
