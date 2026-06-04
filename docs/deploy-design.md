# FitsGL Deployment — `fitsgl deploy` Design

How a built FitsGL dataset directory becomes a live, fast, correctly-cached
website on Cloudflare R2 + CDN, via a single `fitsgl deploy` command.

This document covers **only deployment** — the last unbuilt step of the producer
journey. `build`/`serve`/`init` and the vendored SSG viewer are shipped, so this
supersedes the deployment-specific parts of `producer-cli-design.md` (its §7 step
"deploy", §9 deploy artifacts / cache policy / CORS, §10 step 4), which were
written before those landed and before the caching constraint below. For the
on-disk dataset/`fitsgl.json` wire format this builds on, `config-contract.md` is
authoritative. For the Cloudflare edge-caching analysis behind the decisions here,
see `client-performance-report.md` §5.

Status: design only. Nothing in `fitsgl deploy` is implemented yet. (Note: the
`cli.py` module docstring still says `build` is "currently the only command" and
lists `init`/`serve` as planned — stale; both are wired and shipped. `deploy` is
the genuinely-unbuilt one.)

---

## 1. What we deploy

`fitsgl build` emits one self-contained, fully-static directory at
`<out>/<dataset.name>/` (default `dist/<name>/`), relative-URL'd throughout so it
is relocatable to any origin or subpath:

```
<name>/
  index.html              # vendored SSG viewer (relative ./assets/ URLs)
  assets/                 # index-*.js, index-*.css, worker-*.js
  fitsgl.json             # dataset config (relative band/catalog URLs)
  <band>/manifest.json    # per-band pyramid index (relative level filenames)
  <band>/<stem>_z{0..N}.fits.fz   # one fpacked file per resolution level  ← the bulk
  catalog.csv             # only if [dataset].catalog is set
```

Two file classes matter for deployment, by size and mutability:

- **Tiles** — the `.fits.fz` level files. Large (the dataset is GB-scale; tiles
  dominate every byte). Fetched by HTTP Range into each file's internal tile heap.
- **Pointers** — the small text index files: `fitsgl.json`, every
  `<band>/manifest.json`, and `catalog.csv`. Tiny; these are the only files a
  rebuild's *structure* is read through.

`deploy` operates on this directory; it never re-derives data from the source FITS.

> **Why this layout deploys well.** A whole filter is ~8 `.fits.fz` files (one per
> pyramid level) plus a handful of pointers — *dozens* of objects for a full
> dataset, not the **thousands of per-tile PNGs** a FITSMap-style export produces.
> Managing cache invalidation and purge over thousands of R2 objects is exactly the
> operational pain this design sidesteps: a rebuild touches a handful of objects and
> purges a handful of URLs (see DP5/§4.2 and the resolved purge-granularity note).

## 2. Hard host requirements (the contract `verify` enforces)

Any host MUST satisfy these — they are already exercised locally by `fitsgl serve`
(`serve.py`), which is the reference implementation of this contract:

1. **HTTP Range / `206 Partial Content`** — non-negotiable. The client sends
   `Range: bytes=…` and **hard-throws on a `200`** and on any non-`206` status
   (`fitsgl-core/src/fpack/fpack-file.ts:42-55`). A host that ignores Range is the
   single biggest deploy footgun and it fails *loudly but late* (blank viewer). R2
   serves Range natively; Cloudflare in front of it does too.
2. **Correct MIME types** — `.js` must be a JS type (ES-module `<script>` is
   refused otherwise), `.fits.fz` → `application/octet-stream`, `.json` →
   `application/json`, `.css` → `text/css`, `.csv` → `text/csv`
   (`serve.py:25-51`). On object storage these are set per-object at upload.
3. **CORS only if cross-origin.** Deploying the whole directory to one origin
   (the default here) needs no CORS. We set a permissive bucket CORS anyway so the
   data also works embedded from another site (e.g. CAMPFIRE): `Allow-Origin`
   covering the embedder, `GET`/`HEAD`, allow `Range`, answer the OPTIONS preflight.
4. **Fully static** — zero server-side code. The viewer is a static SPA.

## 3. Locked decisions

Decided with the producer (an astronomer publishing survey mosaics, not a
web-infra specialist — so infra trade-offs are decided here, not deferred to them).

| # | Area | Decision | Reasoning |
|---|---|---|---|
| DP1 | Target | **Cloudflare R2 + CDN** first (S3-compatible API). rsync-to-static-host and S3+CloudFront are later adapters sharing the same core. | Roadmap's original intent ("CDN caches bytes, client caches compute"); object storage is the only realistic home for a GB-scale dataset, and R2 has no egress fees behind Cloudflare. |
| DP2 | Mechanism | **Push-first** — `fitsgl deploy` runs the upload itself, in-process. Credentials come from environment variables, never the config file. Emitting scripts/configs for hand-off (`--emit`) is a later add-on, not v1 of deploy. | One-command UX is the producer's whole ask. Push and a future `--emit` share the same classifier + cache rules, so emit is "render the rules instead of executing them" later. |
| DP3 | Storage | **Exactly one copy of every tile in R2, overwritten in place.** No versioned / content-addressed tile paths, ever. | Hard producer constraint: storing multiple build versions "gets expensive fast." This rules out the classic immutable-versioned-path scheme outright (DP4 is the consequence). |
| DP4 | Caching | **Tiles** (`.fits.fz`): `Cache-Control: public, max-age=<window>, stale-while-revalidate=<grace>` — **no `s-maxage`** (it disables SWR). **Pointers** (`.json`/`.csv`): `public, no-cache` + `ETag`. **Requires one Cloudflare Cache Rule** (§4.4): `.fz` is *not* on Cloudflare's default cacheable-extension allowlist, so tiles are uncached-by-default until a rule marks them eligible. | DP3 forbids `immutable` (the URL's bytes *do* change on rebuild). Once a rule makes `.fz` eligible, Cloudflare honors origin `max-age`/`stale-while-revalidate` by default (Free/Pro/Business — *verified*), keeping warm tiles edge-served (fast, near-zero R2 ops); `no-cache` pointers stay fresh so a rebuild shows at once. |
| DP5 | Freshness | After the full upload, **purge the changed tile URLs from Cloudflare** — strictly **push → purge, never purge → push** (§4.2). Purge-by-URL (all plans; ≤100 URLs/call on Free/Pro/Business) covers even a full rebuild in one call (a dataset is *dozens* of `.fits.fz` objects, §8). | A purge only empties the edge; the next request refills from whatever R2 holds *then*. Purging before the upload re-caches the *old* bytes. Purge-after closes DP4's edge-staleness window to ~zero. |
| DP6 | Incremental | Upload only files whose **content hash changed** since the last deploy, diffed against the previously-deployed `deploy-manifest.json` fetched from the bucket. | A full re-push of a GB-scale dataset on every build is untenable; hashing against the prior manifest is cheaper than per-object `HEAD` calls and independent of R2's ETag/multipart quirks. |
| DP7 | Verification | `deploy` runs a **post-deploy contract check** against the live URL automatically (and it's a standalone `fitsgl verify <url>`). Asserts Range→`206`, MIME, `fitsgl.json` loads; warns on a cold CDN second-fetch. | The #1 failure is a silent non-Range/misconfigured host. The CLI verifier reads response headers directly (no browser CORS limits), so it's the only thing that can prove an edge HIT vs. a silent origin bypass. |
| DP8 | CORS default | Default `viewer_origin = "*"` for public science data; locking to one origin is opt-in. | Tiles are public and unauthenticated; `*` blocks only credentialed requests, which don't exist here. Auth is out of scope entirely. |

**Out of scope (explicitly):** authentication, a hosted gallery / managed
service, dataset discovery/registry, and (for now) `--emit`, rsync/S3 adapters,
and versioned-immutable tiles (DP3 forecloses the last permanently).

## 4. The caching model in detail

### 4.1 Why there's no free lunch, and which trade we took

Given DP3 (one copy, stable URLs), only two honest options remain — and the
producer's cost concern picks between them:

- **`no-cache` + ETag everywhere** — never stale, but every tile request makes the
  edge revalidate with R2 (a round-trip *and* a billable R2 operation per tile).
  Safe but slow and, ironically, the *more expensive* option on R2.
- **`max-age` + push→purge (DP4/DP5, chosen)** — the edge serves tiles with no
  origin contact while warm (fast, and near-zero R2 ops once warm), and a deploy
  purges the edge so there's no edge staleness after a rebuild.

Residual trade-off of the chosen option: a **returning visitor** whose browser
already cached a tile may see the old bytes until that tile's `max-age` expires in
*their* browser (the purge clears Cloudflare's edge, not end-user browsers).
`stale-while-revalidate` softens even this — the browser serves the stale tile
*and* revalidates in the background, so the next view self-heals. **Chosen
defaults:** `max-age=604800` (7 days) + `stale-while-revalidate=2592000` (30 days),
configurable via `[deploy].tile_max_age`. The deploy purge (DP5) keeps the *edge*
fresh for everyone, so the only thing `max-age` bounds is a returning visitor's own
browser cache — which SWR self-heals anyway. For datasets that update rarely (the
norm for published mosaics) a long `max-age` is strictly better: fewer R2
operations, faster repeat loads, no real downside. Bump it higher still (e.g. 30
days) for a frozen dataset; lower it only if you republish often and need returning
collaborators to see pixel changes within the day.

### 4.2 Ordering: push → purge (never the reverse)

This is load-bearing and easy to get backwards. A purge does not insert content;
it empties the edge, and the **next request refills the cache from whatever the
origin holds at that moment** (Cloudflare docs: after a purge "each new request for
a purged resource returns to your origin server… Cloudflare fetches the latest
version… and replaces the cached version").

- **Purge → then push (WRONG):** between the purge and the upload, R2 still has the
  *old* tile. Any request in that gap — and across Cloudflare's globally-independent
  edges the gap is never truly empty — refills the edge with the stale bytes you
  were evicting. Worse than doing nothing.
- **Push → then purge (CORRECT):** by purge time R2 already holds the new bytes, so
  the post-purge refill can only pull the new version. No request can re-cache
  stale content. During purge propagation a not-yet-purged edge may serve the old
  tile slightly longer — exactly the staleness `max-age` already permits, and it
  only ever resolves *toward* the new bytes.

Because the per-file upload and its purge are not atomic, the deploy must
**finish the whole upload before issuing any purge** (don't interleave) — never
purge a URL whose new bytes haven't landed in R2 yet.

### 4.3 The large-object limit (and why `verify` matters)

Cloudflare caches the **whole object** (not per-range segments) and serves
arbitrary byte ranges as `206` from that cached copy — *provided the origin sends
`Content-Length`*, which R2 does (verified). But the **max cacheable object size is
512 MB on Free/Pro/Business** (5 GB on Enterprise); a larger object is not edge-
cached and is served from R2 origin instead — it still works (R2→Cloudflare egress
is free), it just isn't edge-accelerated.

Consequence for a real survey: coarse levels are tiny and cache perfectly, but the
deepest levels of a large mosaic exceed 512 MB. For COSMOS-Web (~90k²), **both `z0`
(~6 GB) and `z1` (~1.5 GB) exceed the cap** (`z≥2` ≤ ~374 MB caches fine); the
threshold is ~26k×26k. Their tiles stream from R2 rather than the edge on
non-Enterprise plans — still correct (R2→Cloudflare egress is free), just not
edge-accelerated, and coarse-to-fine loading hides the latency since these are the
deepest, least-aggregate-traffic levels.

**Cache Reserve does *not* rescue this** — verified: its docs state "CDN cache
limits still apply," so the 512 MB edge cap gates it too; and Enterprise's 5 GB
default doesn't even cover COSMOS-Web's `z0`. No CDN-layer config (Tiered Cache,
Cache Everything, Cache Reserve, Workers Cache API) caches a single >512 MB object.

**The real fix is `supertile-design.md`** — chunk over-cap levels into ≤512 MB
standalone `.fits.fz` supertiles, each independently edge-cacheable. That is a
generator change; deploy itself is unaffected (its classifier already treats every
`*.fits.fz` as a cacheable object, so a chunked level is just more objects). Until
supertiles land, large datasets' deepest 1–2 levels origin-serve (acceptable per
above). **`verify` measures this per level** — `CF-Cache-Status: HIT` on a coarse
tile; a `MISS` on a deep level flags an over-cap object. (An object > 5 GiB also
forces a multipart upload — §6.)

### 4.4 The one required setup step: a Cache Rule

`.fz` is **not** on Cloudflare's default cacheable-extension allowlist (caching is
decided by extension, not MIME type — *verified, and adversarially confirmed
against the docs*), so without configuration a `.fits.fz` tile is `DYNAMIC`
(fetched from R2 on every request) regardless of its `Cache-Control`. Making DP4
real therefore needs exactly **one Cache Rule** on the zone fronting the bucket:

- **Match:** Hostname = the R2 custom domain, AND URI path ends with `.fits.fz`.
- **Cache eligibility:** *Eligible for cache* (the modern successor to the legacy
  "Cache Everything" page rule).
- **Edge TTL:** *Use cache-control header if present, use default Cloudflare
  caching behavior if not* — so our origin `max-age`/`stale-while-revalidate`
  drives the edge TTL (Origin Cache Control is on by default for Free/Pro/Business).

This is a **one-time, per-zone manual setup step**, documented in `docs/r2-setup.md`
(§9) — the user is already creating the bucket and connecting a custom domain by
hand, so adding one Cache Rule fits the same one-time account-setup pass and keeps
the deploy tool's `CLOUDFLARE_API_TOKEN` scoped to purge-only (no zone-config write
access). `verify` detects the rule's absence and prints exactly what to add, so a
forgotten rule surfaces immediately rather than as a silent slow site. Pointers
(`.json`/`.csv`) are intentionally left *out* of the rule — they stay
`DYNAMIC`/origin-served, which is exactly the always-fresh behavior we want for tiny
index files.

## 5. CLI surface

### 5.1 `fitsgl deploy`

```
fitsgl deploy [-c fitsgl.toml] [-o dist] [--dry-run] [--no-verify]
              [--site-only] [--yes]
```

Mirrors `build`'s config/out resolution: reads the `[deploy]` block from the
config and the built dataset at `<out>/<dataset.name>/`. Flow:

1. **Classify** every file in the dataset dir → cache class + content-type +
   content hash; assemble `deploy-manifest.json` (§6).
2. **Diff** against the previously-deployed manifest fetched from the bucket
   (DP6); compute the **upload**, **purge**, and **delete** sets (§6). Purge covers
   changed, header-changed, *and* deleted tiles (see §6); delete removes orphaned
   objects no longer referenced locally.
3. **Upload** the delta to R2 (S3 PUT per object) with per-object `Content-Type`
   and `Cache-Control` (DP4): tiles → pointers/assets → orphan **deletes**; then
   apply bucket CORS (DP8). The `deploy-manifest.json` ledger is *not* written yet.
4. **Purge** the changed + deleted tile URLs from Cloudflare (DP5; after the full
   upload), **batched into ≤100-URL calls** (§8).
5. **Write the `deploy-manifest.json` ledger last** — *after* the purge — so its new
   hashes mark **both** the upload and the purge as complete. An interrupted upload
   *or* a failed purge therefore leaves the *old* ledger, and the next deploy
   re-detects the change and re-uploads/re-purges (self-heals) rather than a
   committed new ledger masking a stale, un-evicted edge copy.
6. **Verify** the live `public_url` (DP7) unless `--no-verify`.

- `--dry-run` — do steps 1–2 and print the upload + purge plan; no writes.
- `--site-only` — push + purge only `index.html`/`assets/` (the analog of `build
  --site-only`); skip tiles/pointers. Fast viewer refresh after re-vendoring.
- `--yes` — skip the "about to upload N files / X MB to <bucket>" confirmation.

### 5.2 `fitsgl verify <url>`

Standalone contract checker (also run by `deploy`). Against a deployed base URL:
fetch `fitsgl.json`; pick a band → its `manifest.json` → a supertile file → a
`Range: bytes=0-1023` request asserting **`206`** (correctness — fails; a `200`
prints the "host ignores Range, blank viewer" diagnosis). It asserts the tile's
`application/octet-stream` and the viewer's `.js` MIME (correctness — fails; the
`.js` check is skipped on a data-only deploy with no `index.html`). With `--origin
<site>` it asserts the CORS preflight returns a matching `Allow-Origin` **and**
permits the `Range` request header (without it the browser blocks the embedder's
ranged GET). It does **not** follow redirects: a 3xx on the dataset URL is reported,
not silently chased, so a custom-domain → `r2.dev` misconfig (uncached, §9) surfaces.

Then the perf checks (warn-only): it HEADs **every supertile** of the coarse level
and `z0` and warns on any object over the 512 MB cap (naming the largest, with the
"lower `[build].supertile_blocks`" fix — *not* Cache Reserve, which §4.3 shows does
not help); and it fetches a tile twice on each, reading `CF-Cache-Status` on the
second — a coarse `MISS` prints the §4.4 Cache Rule recipe, and a `MISS` on `z0`
**only when the coarse level cached** is blamed on the size cap (if both miss, the
missing Cache Rule is the cause, reported on both lines). No `CF-Cache-Status` at all
⇒ the origin isn't behind Cloudflare → the edge checks `skip`. `--strict` promotes
warnings to failures (CI). Being a Python CLI, `verify` reads every response header
directly — unaffected by the browser CORS rules that constrain an in-page debug HUD,
so it is the authoritative HIT-vs-silent-bypass check.

### 5.3 `[deploy]` config + credentials

New `[deploy]` table in `fitsgl.toml` (currently ignored — `config.load_config`
reads only `[dataset]`/`[build]`/`[viewer]`; this adds a `_parse_deploy` and a
`deploy` field on `DatasetConfig`). **Identifiers only — no secrets:**

```toml
[deploy]
target        = "r2"                                      # r2 (only target in v1)
bucket        = "cosmos-web"
endpoint      = "https://<account-id>.r2.cloudflarestorage.com"
public_url    = "https://data.example.org/cosmos-web"     # where it's served
zone_id       = "<cloudflare-zone-id>"                    # for cache purge
prefix        = "cosmos-web"                              # optional key prefix in the bucket
viewer_origin = "*"                                       # CORS Allow-Origin (DP8)
tile_max_age  = 604800                                    # seconds; DP4 window (optional, default 7d)
```

Secrets via environment, validated at startup with a pointed error if missing:
`R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` (S3-compatible keys for R2) and
`CLOUDFLARE_API_TOKEN` (zone-scoped **Cache Purge** edit — and *only* that; the
§4.4 Cache Rule is set up manually, so the tool never needs zone-config write
access).

## 6. Implementation architecture

Keep the repo's pure-logic / side-effect split so the core unit-tests under
pytest with no network:

- **`deploy_plan.py` (pure):** walk the dataset dir → classify each file (tile vs.
  pointer vs. site asset) → content hash + content-type + `Cache-Control` →
  `DeployManifest`. Diff two manifests → a `DeployDiff` of `upload` / `purge` /
  `delete` / `unchanged`. The diff keys on `sha256` (DP6) **and** the serving
  headers: a tile whose bytes are unchanged but whose `Cache-Control` changed (e.g.
  a lowered `tile_max_age`) is re-uploaded + purged, since a hash-only diff would
  silently strand the old header on the R2 object. `purge` collects tiles that
  changed, that only changed headers, *and* that were deleted — a deleted tile's
  R2 object is gone but its warm edge copy could shadow the 404 for a client
  holding a pre-deploy manifest; purging it after the delete trivially satisfies
  DP5's ordering (no new bytes, so the refill can only resolve toward 404).
  `delete` is the supertile-era addition: a re-tile (changed `supertile_blocks`, a
  grown mosaic) renames supertile files, so the old ones must be removed or R2
  accumulates dead objects (DP3). `chunk_purge_urls` batches the purge list to
  ≤100 URLs/call. Fully testable on fixtures; no boto3, no network.
- **`deploy.py` (I/O):** an `R2Target` adapter — boto3, an optional
  `pip install fitsgl[deploy]` extra (R2 speaks S3; all of the following *verified*
  against R2's S3-compat docs). `put_object(..., ContentType=, CacheControl=)` sets
  both per object (boto3 does **not** auto-detect content-type on `put_object`, so
  the classifier supplies it). `get_object` fetches the prior manifest. R2
  implements `put_bucket_cors` — the only programmatic way to set R2 CORS — but R2
  **rejects `AllowedHeaders: ["*"]`**, so list explicit headers (`["range"]`;
  methods `GET`/`HEAD`; origins `[viewer_origin]`). Files > 5 GiB (a large `z0`)
  exceed the single-PUT limit → use boto3's `upload_file`/TransferManager, which
  switches to multipart automatically. A `CloudflarePurge` helper does the
  `POST /zones/{zone_id}/purge_cache` `{"files":[…]}` call (stdlib `urllib`).
  Orchestration = the §5.1 flow.
- **`verify.py` (I/O):** the §5.2 checks; importable so `deploy` calls it and the
  `verify` subcommand wraps it.
- **`cli.py`:** add `deploy` and `verify` subparsers alongside `init`/`build`/
  `serve`; fix the stale module docstring while there.

`deploy-manifest.json` schema (also the incremental-sync ledger, DP6):

```json
{
  "schemaVersion": 1,
  "dataset": "cosmos-web",
  "files": [
    { "path": "f444w/img_z0.fits.fz", "class": "tile",
      "contentType": "application/octet-stream",
      "cacheControl": "public, max-age=604800, stale-while-revalidate=2592000",
      "sha256": "…", "size": 44512 },
    { "path": "fitsgl.json", "class": "pointer",
      "contentType": "application/json",
      "cacheControl": "public, no-cache", "sha256": "…", "size": 1820 }
  ]
}
```

Incremental note: change detection uses the manifest's **`sha256`**, *not* R2's
ETag — deliberately, because a multipart upload's ETag is `md5-of-md5s-N`, not a
plain content MD5, so it can't be compared to a local hash. The manifest hash is
robust whether a file went up single-part or multipart. (Coarse levels are single-
part PUTs; only a large `z0` may go multipart — §4.3/§6.)

## 7. Build order

1. **`deploy_plan.py` + `deploy-manifest.json`** — classifier and diff. Pure,
   tested, no network. The testable heart.
2. **`fitsgl verify <url>`** — high value immediately; usable against a manually-
   uploaded dataset before push exists.
3. **`fitsgl deploy` (R2 push)** — `R2Target` upload (incremental, per-object
   headers, CORS) + Cloudflare purge + auto-verify; `--dry-run` first.
4. **`[deploy]` config parsing + `init` scaffold** of a commented `[deploy]` stub.
5. **Later / optional:** `--emit` (render upload scripts + per-host configs for
   hand-off), rsync/static-host and S3 adapters. (DP3 keeps versioned-immutable
   tiles permanently off the table.)

## 8. Resolved questions

All open questions are now resolved (Cloudflare/R2 facts verified against official
docs, June 2026; the load-bearing default-caching claim was adversarially
confirmed):

- **Purge granularity.** ✅ The purgeable unit is the **per-supertile `.fits.fz`
  file** (one cached object per supertile; the 256² render-tiles are byte-ranges
  *inside* it). For a small/un-chunked dataset a level is one file, so a filter is
  ~8 objects and a full-rebuild purge is *dozens* of URLs. But a **supertiled**
  large mosaic (the reason supertiles exist) splits deep levels into many files, so
  a full-rebuild purge can exceed the **100 URLs/call cap** (Free/Pro/Business; all
  purge methods on all plans as of Apr 2025) — so the purge list is **batched into
  ≤100-URL calls** (`chunk_purge_urls`), not assumed to fit in one. No
  purge-everything in the normal path; keep `--purge-all` only as a guarded escape
  hatch (e.g. after a cache-policy change).
- **`tile_max_age` default.** ✅ `max-age=604800` (7 days) +
  `stale-while-revalidate=2592000` (30 days) (Cloudflare honors SWR — verified).
  Long `max-age` is the right default because the deploy purge keeps the *edge*
  fresh for everyone and SWR self-heals returning browsers (§4.1); rarely-updated
  datasets can go higher. Configurable; lower only for frequent-republish workflows.
- **boto3 vs. rclone.** ✅ **boto3**, optional `fitsgl[deploy]` extra. Verified it
  sets per-object `ContentType`/`CacheControl` and is the *only* one of the two that
  can set R2 bucket CORS in-process (`put_bucket_cors`); rclone can't manage CORS and
  is an external binary. Incremental diff is ours via the manifest `sha256` (§6), so
  rclone's sync ergonomics aren't needed. rclone stays the natural backend for a
  future `--emit`/multi-cloud path.
- **`verify` severity.** ✅ Tiered. Correctness checks (Range→`206`, MIME,
  `fitsgl.json` loads) **fail** (non-zero exit); the cold-CDN cache-`MISS` check only
  **warns** (a small `z0` may legitimately not need a rule/Cache Reserve, and a MISS
  doesn't break the site). `--strict` promotes warnings to failures for CI.

- **Cache Rule: auto-create vs. manual.** ✅ **Manual, documented** (`docs/r2-setup.md`,
  §9). The user already creates the bucket and connects the custom domain by hand, so
  the Cache Rule joins that same one-time account-setup pass. This keeps the deploy
  token scoped to **purge-only** — the tool never needs zone-config write access — and
  `verify` flags a missing rule immediately, so "forgot the rule" can't become a silent
  slow site. No `--ensure-cache-rule` flag in v1 (could be a later convenience if
  demand appears).

## 9. Companion docs

- ✅ **`docs/r2-setup.md` — R2 deployment setup guide** (written; the code has landed).
  Assumes basic familiarity (the
  user has a Cloudflare account and understands object storage); covers only the
  bucket/account configuration that **can't be done from the CLI**, and ends by
  spelling out exactly which identifiers/keys FitsGL needs and where they go. Most
  R2-route users will know this already, but the guide removes guesswork. Planned
  contents:
  - Create the bucket; connect a **custom domain** so it's served through the CDN
    (the managed `r2.dev` subdomain is *not* edge-cached — a custom domain is
    required).
  - The **required Cache Rule** for `.fits.fz` (the exact recipe in §4.4 — match
    hostname + `.fits.fz` suffix, "Eligible for cache", Edge TTL "respect origin").
    Without it tiles are uncached regardless of headers — so this is a load-bearing
    one-time step, called out prominently. `verify` flags it if skipped.
  - Optional **Cache Reserve** for `z0` level files over the 512 MB edge limit (§4.3).
  - The **keys checklist** mapping each credential to its env var and each identifier
    to its `[deploy]` field: `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` (R2 S3 token),
    `CLOUDFLARE_API_TOKEN` (scoped to cache-purge, and cache-rule edit if we automate
    it), plus `bucket` / `endpoint` (account id) / `zone_id` / `public_url`.
  - A note that the **university-static-host route needs none of this** — it's the
    R2-route reader's guide specifically.
