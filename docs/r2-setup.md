# FitsGL — Cloudflare R2 Deployment Setup

`fitsgl deploy` pushes a built dataset to a **Cloudflare R2** bucket and serves it
through Cloudflare's CDN. The tool does everything it *can* from the command line —
the per-object content types, the bucket CORS, the incremental upload, and the
post-deploy edge purge. This guide covers only the handful of things that **cannot
be done from the CLI**: the one-time bucket + account setup you do by hand in the
Cloudflare dashboard, and the credentials/identifiers FitsGL needs to find.

You only need this if you're deploying to R2. **Publishing to a university or lab
static web host instead?** None of this applies — just copy the built `dist/<name>/`
directory onto that host (it's a self-contained static site) and make sure the host
honors HTTP `Range` requests (`fitsgl serve` is the local reference; run `fitsgl
verify <url>` against the host to check). The rest of this document is for the R2
route specifically.

It assumes you have a Cloudflare account and a domain managed by Cloudflare, and a
rough sense of what object storage is. Most R2 users will already know these steps;
this just removes the guesswork and flags the one step that's easy to miss.

> The deploy invariants (the host contract, the caching model, push-then-purge) are
> summarized in `../CLAUDE.md`, and the `[deploy]` config fields are documented in
> `cli.md`. This is the operational how-to.

---

## The setup at a glance

Four one-time steps in the Cloudflare dashboard, then you fill in `[deploy]` +
two/three secrets (in a `.env` file or your shell) and run `fitsgl deploy`:

1. **Create the R2 bucket.**
2. **Connect a custom domain** to it (the managed `r2.dev` URL is *not* CDN-cached).
3. **Add one Cache Rule** for `.fits.fz` — *the easy-to-miss, load-bearing step*.
4. **Create two API tokens** (R2 upload + Cloudflare cache-purge).

Then: §5 fills in the credentials, §6 verifies it worked.

---

## 1. Create the R2 bucket

In the Cloudflare dashboard: **R2 → Create bucket**. Pick a name (e.g.
`cosmos-web`) and a location. That's it — the bucket name becomes `[deploy].bucket`.

You can keep several datasets in one bucket by giving each a key **prefix**
(`[deploy].prefix`); leave it empty to put one dataset at the bucket root.

## 2. Connect a custom domain (required)

R2 gives every bucket a managed `*.r2.dev` URL, but **that URL is *not* served
through Cloudflare's CDN** — its tiles would never be edge-cached, so every request
hits the origin. You must connect a **custom domain** instead.

In the bucket: **Settings → Custom Domains → Connect Domain**, and enter a hostname
on a zone you manage in Cloudflare (e.g. `data.example.org`). Cloudflare adds the
DNS record and routes that hostname to the bucket through the CDN.

This custom domain is where browsers fetch the data — it's the basis of
`[deploy].public_url`. Note it's a **different** address from the S3 upload
`endpoint` in §5 (the endpoint is where `fitsgl deploy` *writes* objects; the custom
domain is where the viewer *reads* them).

## 3. Add the Cache Rule for `.fits.fz` — don't skip this

**This is the one step that's easy to miss and breaks edge caching if you forget
it.** Cloudflare decides what to cache by *file extension*, and `.fits.fz` is not on
its default cacheable list — so without a rule, every tile is fetched from R2 origin
on every request regardless of the `Cache-Control` headers `fitsgl deploy` sets.
The site still works, just slowly and with more R2 operations.

One Cache Rule fixes it. In the dashboard for the zone (the domain from §2):
**Caching → Cache Rules → Create rule**, and set:

- **Rule name:** anything (e.g. `fitsgl tiles`).
- **When incoming requests match (the expression):**
  - Hostname **equals** your custom domain (e.g. `data.example.org`), **AND**
  - URI Path **ends with** `.fits.fz`.
- **Then → Cache eligibility:** **Eligible for cache**.
- **Edge TTL:** **Use cache-control header if present, use default Cloudflare
  caching behavior if not** — so the `max-age` / `stale-while-revalidate` that
  `fitsgl deploy` writes on each tile drives how long the edge holds it.

Leave everything else default. Save and deploy the rule.

You do **not** need a rule for the small index files (`fitsgl.json`, the
`manifest.json`s, `catalog.csv`): they're served `no-cache` on purpose so a rebuild
shows immediately, and leaving them off this rule is exactly the always-fresh
behavior you want.

`fitsgl verify <url>` checks for this rule and tells you the exact recipe if it's
missing (a coarse tile that returns `CF-Cache-Status: MISS` on a repeat fetch).

## 4. Create the API tokens

FitsGL reads secrets from the **environment** (or a `.env` file — see §5), never
from `fitsgl.toml`. You need two tokens, each scoped to exactly what it does:

**(a) R2 upload token** — lets `fitsgl deploy` write objects *and set the bucket
CORS policy* (both S3-compatible). In the dashboard: **R2 → Manage R2 API Tokens →
Create API Token**. Permission **Admin Read & Write**, scoped to your bucket.
Cloudflare shows you an **Access Key ID** and a **Secret Access Key** — these become
`R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`. (Copy the secret now; it's shown only
once.)

> **Why Admin, not Object Read & Write?** R2's *Object* permission can upload and
> delete files but cannot change *bucket configuration*. `fitsgl deploy` applies the
> bucket's CORS policy for you (so a browser on your viewer origin may fetch tiles
> cross-site), and CORS is a bucket-config operation — so an Object-only token
> uploads every file fine and then fails with `AccessDenied` on the final
> `PutBucketCors` step. **Admin Read & Write** (still scoped to the one bucket) is the
> least privilege that covers the whole deploy.

**(b) Cloudflare cache-purge token** — lets `fitsgl deploy` evict changed tiles from
the edge after a push, so a redeploy is visible immediately. This is *optional*: skip
it and the deploy still works, but changed tiles serve from the edge until their
`tile_max_age` expires (and the next viewer load self-heals via
`stale-while-revalidate`). To enable it: **My Profile → API Tokens → Create Token →
Create Custom Token**, with a single permission **Zone → Cache Purge → Purge**, scoped
to your zone. That token string becomes `CLOUDFLARE_API_TOKEN`. The deploy tool needs
no other Cloudflare permission — the Cache Rule in §3 is set up by hand, so the token
never needs zone-config write access.

## 5. Fill in `[deploy]` and the environment

Add a `[deploy]` table to your `fitsgl.toml` (`fitsgl init` scaffolds a commented
stub you can uncomment and fill in). **Identifiers only — no secrets here:**

```toml
[deploy]
target        = "r2"
bucket        = "cosmos-web"                                     # §1
endpoint      = "https://<account-id>.r2.cloudflarestorage.com"  # S3 upload URL (see below)
public_url    = "https://data.example.org/cosmos-web"            # §2 custom domain (+ prefix)
zone_id       = "<cloudflare-zone-id>"                           # for the cache purge (§4b)
prefix        = "cosmos-web"                                     # optional key prefix; "" for none
viewer_origin = "*"                                              # CORS Allow-Origin
tile_max_age  = 604800                                           # optional, seconds (default 7 days)
```

Where each value comes from:

| Field / variable | What it is | Where to find it |
|---|---|---|
| `[deploy].bucket` | the R2 bucket name | §1 |
| `[deploy].endpoint` | the **S3 upload** API URL (boto3 writes here) | `https://<account-id>.r2.cloudflarestorage.com`; the account id is on the R2 overview page |
| `[deploy].public_url` | where the dataset is **served** to browsers | your §2 custom domain, plus the `prefix` if you use one (e.g. `https://data.example.org/cosmos-web`) |
| `[deploy].zone_id` | the Cloudflare zone of the custom domain | the zone's **Overview** page → API → **Zone ID** (needed only for the purge) |
| `[deploy].prefix` | optional key prefix inside the bucket | your choice; `""` to serve at the bucket/domain root |
| `[deploy].viewer_origin` | CORS `Allow-Origin` for cross-site embedding | `"*"` for public science data; a specific site to lock it down |
| `[deploy].tile_max_age` | how long the edge serves a tile before revalidating | your choice; longer is better for rarely-updated datasets |
| `R2_ACCESS_KEY_ID` *(env or .env)* | R2 S3 access key | §4a |
| `R2_SECRET_ACCESS_KEY` *(env or .env)* | R2 S3 secret key | §4a (shown once) |
| `CLOUDFLARE_API_TOKEN` *(env or .env)* | cache-purge token | §4b (omit to skip the edge purge) |

> **`endpoint` vs `public_url`** is the usual point of confusion: `endpoint` is the
> S3 address `fitsgl deploy` *uploads* to (`<account-id>.r2.cloudflarestorage.com`);
> `public_url` is your custom domain that the *viewer* fetches from. They're
> independent — `prefix` (the bucket key prefix) and the path in `public_url` don't
> have to match, as long as your custom-domain routing maps one to the other.

Now give `fitsgl deploy` the three secrets. The easiest way is a **`.env` file
next to your `fitsgl.toml`** — `fitsgl deploy` reads it automatically, so you set
the keys once instead of re-exporting them every shell:

```bash
# .env  — sits next to fitsgl.toml; one KEY=value per line
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
CLOUDFLARE_API_TOKEN=...      # optional, enables the edge purge
```

> ⚠️ **This file holds live credentials — never commit it.** Add `.env` to your
> `.gitignore` before you fill it in. (Quote any value that contains spaces or a
> `#`, e.g. `CLOUDFLARE_API_TOKEN="abc#123"`.)

Prefer to keep the `.env` elsewhere (e.g. one shared file outside the dataset
dir)? Point `fitsgl deploy` at it with `--env-file path/to/secrets.env`.

You don't have to use a file at all — exporting the variables in your shell (or a
CI secret store) works exactly the same:

```bash
export R2_ACCESS_KEY_ID=...
export R2_SECRET_ACCESS_KEY=...
export CLOUDFLARE_API_TOKEN=...    # optional, enables the edge purge
```

A variable already set in the environment **takes precedence** over the same key
in the `.env` file — so a CI secret store or a one-off `export` always wins, and a
stale `.env` can't silently override it.

Install the deploy extra (it pulls in boto3, which the base install omits) — from a
checkout of this repo, in the `fitsgl-py/` directory:

```bash
pip install -e ".[deploy]"
```

## 6. Deploy and verify

```bash
fitsgl deploy --dry-run     # shows the upload/delete/purge plan; writes nothing
fitsgl deploy               # the real push (prompts before uploading; --yes to skip)
fitsgl verify https://data.example.org/cosmos-web   # also run automatically after a deploy
```

`fitsgl deploy` uploads only what changed since the last deploy, sets each object's
content type and cache headers, applies the bucket CORS, purges the changed tiles
from the edge, and then runs `verify` against the live URL. `verify` confirms the
host honors `Range` requests, serves the right MIME types, and — the perf check —
that tiles are actually edge-cached (a `CF-Cache-Status: MISS` on a coarse tile is
the telltale sign the §3 Cache Rule is missing or misconfigured).

Re-running `fitsgl deploy` after a rebuild is incremental and safe to run as often
as you like. To refresh just the viewer after re-vendoring (no data re-upload):
`fitsgl deploy --site-only`.

---

## A note on large tiles and "Cache Reserve"

Cloudflare's edge won't cache a single object larger than **512 MB** (on
Free/Pro/Business plans). FitsGL avoids this automatically: the build chunks every
pyramid level into **supertiles** that each stay under the cap, so on a default
build no `.fits.fz` exceeds it and every
tile is edge-cacheable.

You may see **Cache Reserve** suggested for "large objects." It does **not** raise
the 512 MB cap — Cloudflare's CDN size limits apply to it too — so it is *not* the
fix for an over-cap tile. (If `fitsgl verify` ever flags an object over 512 MB,
lower `[build].supertile_blocks` and rebuild so that level chunks into smaller
files.) Cache Reserve is only worth enabling as a separate cost optimization — it
persists popular tiles in a central tier so they're re-pulled from R2 less often —
and it's entirely optional.
