# FitsGL Config Contract (v1)

The single producer→viewer contract: **one input config (`fitsgl.toml`) and one
emitted artifact (`fitsgl.json`)**, both built around the same separation —
*dataset* (what data exists and where) vs *viewer* (the overridable default view).

**Supersedes** the contract portions of `producer-cli-design.md` (§2, §4, §6).
That doc conflated the data inventory with the view (two `default_rgb` sources)
and treated grid mismatch as a build error; the model below is authoritative.
Core principle: **the data never dictates the view.** RGB role assignment, stretch,
and colormap are *view state* the user changes live; the producer only sets the
initial state.

---

## 1. The split

| Concern | Lives in | Nature |
|---|---|---|
| **Dataset** — bands, their pyramid locations, per-band WCS/grid, catalog | `[dataset]` → `dataset` | mechanical, derived from the FITS files |
| **Viewer** — default mode, default R/G/B (or band), stretch, colormap, north-up | `[viewer]` → `defaultView` | a *preference*; the only place a default is declared; fully live-overridable |

A band may sit on a **different WCS grid** from its siblings (e.g. ground-based +
JWST of the same field). That is allowed. The only operation constrained by grid
is RGB compositing, which is gated at composite time by the existing TS
`gridsMatch`. The build therefore **warns** on mixed grids and never fails; the
viewer's picker uses the per-band **grid group** to offer RGB only within one group.

---

## 2. Input — `fitsgl.toml`

```toml
[dataset]
name    = "cosmos-web"              # machine key; output dir + URL slug
title   = "COSMOS-Web JWST"         # human label, shown in the viewer chrome
catalog = "catalogs/sources.csv"    # optional; v1 = a CSV already in the M3 schema

[[dataset.bands]]
name  = "f444w"
input = "mosaics/cosmos_f444w.fits"
[[dataset.bands]]
name  = "f277w"
input = "mosaics/cosmos_f277w.fits"
[[dataset.bands]]
name  = "f150w"
input = "mosaics/cosmos_f150w.fits"
[[dataset.bands]]
name  = "subaru_r"                  # different grid — allowed; just not RGB-able with JWST
input = "mosaics/subaru_r.fits"

[build]                             # passes through to build_pyramid
quantize_level = 8
tile_size      = 256
processes      = 0                  # 0 = auto

[viewer]                            # the DEFAULT view only; all live-overridable
default  = "rgb"                    # "single" | "rgb"
r = "f444w"                         # when default = "rgb"
g = "f277w"
b = "f150w"
# band = "f444w"                    # when default = "single"
stretch  = "asinh"                  # linear | asinh | log
colormap = "gray"                   # single mode only; ignored for rgb
north_up = true
```

**Field rules**

- `dataset.name` — `[a-z0-9-]+`; becomes the output dir and URL slug.
- `[[dataset.bands]].name` — unique; must not collide with reserved output names
  (`dataset`, `catalog`, `fitsgl`, `index`, `deploy`, `embed`). Becomes the band's
  subdirectory.
- `input` — resolved **relative to the toml file's directory** (reproducible across
  CWDs); absolute paths allowed.
- `viewer.r/g/b` (or `viewer.band`) — must name declared bands. If the `rgb` default
  spans grid groups, the build emits a **warning** and still writes the config; the
  viewer falls back to single-band if the composite can't form.
- A single-band dataset is the degenerate case: one band, `default = "single"`,
  `viewer.band` optional (defaults to the sole band).

---

## 3. Emitted artifact — `fitsgl.json`

One file, written to the dataset directory, read by every tier. URLs are **relative
to this file's own location** (see §5).

```jsonc
{
  "schemaVersion": 1,

  "dataset": {
    "name":  "cosmos-web",
    "title": "COSMOS-Web JWST",
    "bands": [
      { "name": "f444w",    "tiles": ["f444w/manifest.json"],    "grid": { "group": 0, "pixelScaleArcsec": 0.030 } },
      { "name": "f277w",    "tiles": ["f277w/manifest.json"],    "grid": { "group": 0, "pixelScaleArcsec": 0.030 } },
      { "name": "f150w",    "tiles": ["f150w/manifest.json"],    "grid": { "group": 0, "pixelScaleArcsec": 0.030 } },
      { "name": "subaru_r", "tiles": ["subaru_r/manifest.json"], "grid": { "group": 1, "pixelScaleArcsec": 0.168 } }
    ],
    "catalog": { "url": "catalog.csv" }
  },

  "defaultView": {
    "mode": "rgb",
    "r": "f444w", "g": "f277w", "b": "f150w",
    "stretch": { "mode": "asinh" },
    "northUp": true
  }
}
```

Single-band default:

```jsonc
"defaultView": {
  "mode": "single",
  "band": "f444w",
  "colormap": "gray",
  "stretch": { "mode": "asinh" },
  "northUp": true
}
```

### `dataset` (inventory)
| Field | Type | Notes |
|---|---|---|
| `name` | string | machine key |
| `title` | string? | display label |
| `bands[]` | Band[] | ≥1 |
| `catalog` | `{ url }`? | overlay markers; url is config-relative |

### `Band`
| Field | Type | Notes |
|---|---|---|
| `name` | string | unique key the view references |
| `tiles[]` | string[] | manifest URL(s), config-relative. Length 1 today; N is the M6 tiled-mosaic case (D14) |
| `grid.group` | int | co-gridded grouping id (§4). Bands with the same `group` can be RGB-composited |
| `grid.pixelScaleArcsec` | number? | for labels/scale bar |

### `defaultView` (the only default)
| Field | Type | Notes |
|---|---|---|
| `mode` | `"single" \| "rgb"` | |
| `band` | string | mode=single; defaults to first band if omitted |
| `r` `g` `b` | string | mode=rgb; each names a band |
| `colormap` | ColormapName? | mode=single only; ignored for rgb |
| `stretch` | `{ mode? }`? | `mode` ∈ linear/asinh/log. **v1 reads only `mode`** — the explorer auto-stretches the data in view and drives the black/white points itself. Pinned `range`/`channels` (for reproducible science defaults) are *reserved* for a later version (when the explorer seeds from them instead of auto). |
| `northUp` | boolean? | omit → viewer default (on when WCS present) |

---

## 4. Grid groups

Each band gets a `grid.group` integer. Two bands share a group **iff** their z=0
WCS + shape are co-gridded. Computation reuses the existing advisory `grid_hash`
(canonical CTYPE/shape/CRPIX/CRVAL/CD): bands are bucketed by hash, groups numbered
by first appearance. `group` is an **advisory grouping hint** for the picker, not the
gate — the authoritative RGB compatibility check stays the TS `gridsMatch` at
`RenderSource` construction. The picker offers/permits an RGB triple only within one
group and greys cross-group bands once a channel is set (the build already warned if
the *default* spanned groups).

---

## 5. URL resolution

`tiles[]` and `catalog.url` are resolved with `new URL(path, configUrl)` where
`configUrl` is the URL the config was fetched from. A new loader owns this:

```ts
const cfg = await loadFitsglConfig('https://cdn/cosmos-web/fitsgl.json');
// internally: fetch + validate + every band.tiles[i] and catalog.url
//             resolved against the config URL → absolute, cross-origin-safe.
<FitsViewer config={cfg} />
```

This fixes the cross-origin break: a React/CAMPFIRE host fetching the config from a
CDN gets absolute tile/catalog URLs, not paths resolved against its own origin. An
explicit `baseUrl` override is accepted for unusual layouts. **This is a
`fits-pyramid` code change**, landed in Phase 0.

---

## 6. Catalog (v1 scope)

v1 accepts **a CSV already in the M3 overlay schema** (`# fitsgl-catalog v1` line,
columns `id,x,y,ra,dec,flux` + extras). The build copies it into the dataset dir as
`catalog.csv` and **validates** it (version line present, at least `ra`+`dec` or
`x`+`y` columns, no all-NaN coordinate column) — failing loudly at build time rather
than letting the TS reader silently drop rows. Richer ingestion (FITS BINTABLE,
arbitrary CSV with `ra_col`/`dec_col` aliasing) is a later addition; the field stays
`[dataset].catalog = <path>` so the toml does not change when it grows.

---

## 7. Validation rules (build-time + `validateFitsglConfig`)

1. `schemaVersion` present and known (reject unknown).
2. `dataset.bands` non-empty; band `name`s unique; none a reserved name.
3. each band `tiles` non-empty; v1 length 1 (length>1 → clear M6 error).
4. `defaultView` band references resolve to declared bands.
5. `defaultView.colormap` only with `mode=single`; a known ColormapName.
6. `stretch.range` only with single, `stretch.channels` only with rgb; finite, `max>min`.
7. an `rgb` default whose three bands span grid groups → **warning**, not error.
8. `catalog.url` (if present) points at a file that passed §6 validation.

---

## 8. Mapping `fitsgl.toml` → `fitsgl.json`

| toml | →  | contract / code |
|---|---|---|
| `[[dataset.bands]].input` + `[build]` | per band | `build_pyramid(input, …)` → `<name>/manifest.json` |
| `[[dataset.bands]].name` + grid hash | | `dataset.bands[]` with `grid.group` |
| `[dataset].catalog` | validated+copied (§6) | `dataset.catalog.url = "catalog.csv"` |
| `[dataset].name/title` | | `dataset.name/title` |
| `[viewer].default/r/g/b/band` | | `defaultView.mode` + band refs |
| `[viewer].stretch` | | `defaultView.stretch.mode` |
| `[viewer].colormap` (single) | | `defaultView.colormap` |
| `[viewer].north_up` | | `defaultView.northUp` |

---

## 9. TS types (shipped — `src/fitsgl-config.ts`)

`FitsglConfig` sits **above** `ViewerConfig`, which is unchanged — it stays the bare
`<FitsViewer>`'s controlled *view* contract, while `FitsglConfig` is the producer
artifact (inventory + default view) that `<FitsExplorer config>` consumes and that a
host maps to a static `ViewerConfig.view` when wiring the bare viewer.

```ts
interface FitsglBand { name: string; tiles: string[]; grid: { group: number; pixelScaleArcsec?: number }; label?: string; }
interface FitsglDataset { name: string; title?: string; bands: FitsglBand[]; catalog?: { url: string }; }
interface FitsglDefaultView {
  mode: 'single' | 'rgb';
  band?: string; r?: string; g?: string; b?: string;   // band selection
  colormap?: ColormapName;                              // single only
  stretch?: { mode?: StretchMode };                     // v1: mode only (§3)
  northUp?: boolean;
}
interface FitsglConfig { schemaVersion: number; dataset: FitsglDataset; defaultView: FitsglDefaultView; }
```

- `validateFitsglConfig(raw)` — structural validation (§7).
- `resolveFitsglConfig(config, baseUrl)` — resolve `tiles`/`catalog.url` against the
  config URL. `loadFitsglConfig(url)` = fetch + validate + resolve. **This is the
  cross-origin fix**: resolution happens at load, so the viewer always receives
  absolute URLs — no `loadViewerSource` change was needed.
- `fitsglConfigFromDataset(dataset, url)` — transition bridge from a legacy
  `dataset.json` (grid groups via `gridsMatch`; `default_rgb` → default view).
- `<FitsExplorer>` takes `config?: FitsglConfig` (turnkey) or the loose
  `bands`/`defaultView`/`catalog`/`title` props. Inline host-pushed markers remain a
  runtime API (`{ markers }`), not a producer-emitted field.
