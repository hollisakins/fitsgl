# Integrating `@fitsgl/core`

`@fitsgl/core` is the browser-side half of FitsGL: it fetches a served FITS tile
pyramid over HTTP byte-range requests, decodes the RICE/GZIP tiles in the
browser, and renders the mosaic in WebGL2. The data it consumes (the `.fits.fz`
tiles, `manifest.json`, `fitsgl.json`) is produced by the `fitsgl` CLI — see
[docs/cli.md](./cli.md). This guide covers consuming the published library in a
web app.

## Install

```bash
npm install @fitsgl/core
# React tier: also install react (and react-dom for your app)
npm install react react-dom
```

The package is pure ESM, ships its own `.d.ts`, and is built with `tsc` (no
bundler assumptions). The `./react` subpath declares `react` and `@types/react`
(>=18) as *optional* peer dependencies — you only need them if you use that
subpath.

### Installing from a git ref (before/without a published version)

`@fitsgl/core` lives in the `fitsgl-core/` **subdirectory** of the
`hollisakins/fitsgl` monorepo. It carries a `prepare` hook, so a git install
builds `dist/` on the fly — but only with a package manager that can target a
repo subdirectory. **pnpm** and **yarn** can; pin a commit with:

```jsonc
// package.json (pnpm / yarn) — pins fitsgl-core at a commit
"@fitsgl/core": "github:hollisakins/fitsgl#<sha>&path:/fitsgl-core"
```

**npm cannot install from a git subdirectory**, so npm consumers must use the
published package (`npm install @fitsgl/core` above). This is the recommended
path for everyone regardless of package manager.

## Entry points

The package exposes four subpaths:

| Subpath | What it is | Use when |
| --- | --- | --- |
| `@fitsgl/core` | Core: manifest/dataset loaders, `TilePyramid` (tiles over range requests), the vanilla WebGL2 `FitsViewer`, plus stretch/colormap/WCS/overlay math. The frozen public API. | You want a framework-agnostic viewer, or you're building your own React/Vue/etc. wrapper. |
| `@fitsgl/core/react` | React components: `<FitsExplorer>` (batteries-included viewer + control panel) and `<FitsViewer>` (bare canvas component + ref handle). | You have a React app — this is the easiest path. |
| `@fitsgl/core/worker` | The stateless tile-decode worker entry, wired via `new Worker(new URL('@fitsgl/core/worker', import.meta.url), { type: 'module' })`. The core auto-spawns its own worker by default; point at this only when supplying a custom `workerFactory` (e.g. a bundler that needs an explicit worker URL). | You bundle your own decode worker instead of the built-in one. |
| `@fitsgl/core/internal` | Lower-level building blocks (RICE/fpack decoders, worker glue, tile-selection helpers). **No semver guarantee** — see the warning below. | Almost never. Tools/tests/advanced hosts only. |

## A FitsGL dataset on the wire

A deployed dataset is a static directory served over HTTP with byte-range support
(`Accept-Ranges: bytes`). The relevant files:

- **`fitsgl.json`** — the *producer contract*: the band inventory plus a default
  view (mode, RGB roles, stretch, colormap), an optional catalog, and a title.
  This is what the React tier and the SSG viewer gate on. `loadFitsglConfig(url)`
  fetches + validates it and resolves the band/catalog URLs relative to the
  config's own URL.
- **`manifest.json`** (one per band) — the per-band pyramid index: native shape,
  level count, tile geometry, WCS, compression hint. Convenience index only; the
  `.fits.fz` files are self-describing and authoritative.
- **`.fits.fz`** — the fpacked tiles the decoder range-fetches and decompresses.
- **`collection.json`** (optional, at a deploy root) — a multi-field landing
  index; `loadCollection(url)` returns it, or `null` when there's none at that
  URL.

## Easiest: drop in `<FitsExplorer>`

`<FitsExplorer>` is a complete viewer: a WebGL2 canvas plus a built-in control
panel (single/RGB band picker, stretch, colormap, black/white-point sliders with
live histograms, north-up, catalog overlay) and a status bar. Point it at a
`fitsgl.json` and it's interactive out of the box.

```tsx
import { useEffect, useState } from 'react';
import { FitsExplorer } from '@fitsgl/core/react';
import { loadFitsglConfig, type FitsglConfig } from '@fitsgl/core';

const CONFIG_URL = new URL('fitsgl.json', document.baseURI).href;

export function App() {
  const [config, setConfig] = useState<FitsglConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    loadFitsglConfig(CONFIG_URL)
      .then((c) => { if (live) setConfig(c); })
      .catch((e: unknown) => { if (live) setError(String(e)); });
    return () => { live = false; };
  }, []);

  if (error !== null) return <div>Failed to load: {error}</div>;
  if (config === null) return <div>Loading…</div>;

  // Size the explorer by sizing its container.
  return (
    <div style={{ width: '100vw', height: '100vh' }}>
      <FitsExplorer config={config} onError={(e) => setError(String(e))} />
    </div>
  );
}
```

Key `FitsExplorerProps` (all optional unless noted):

- `config?: FitsglConfig` — turnkey: supplies bands + default view + catalog +
  title. Takes precedence over the loose props below.
- `bands?: ExplorerBand[]`, `defaultView?: ExplorerDefaultView` — supply the
  inventory directly instead of a `config`.
- `catalog?: MarkerInput[] | { url: string }` — overlay markers, pre-parsed or a
  CSV URL the component fetches.
- `title?: string` — status-bar label (defaults to `config.dataset.title`).
- `tileOptions?: TilePyramidOptions`, `textureBudget?: number`, `hiDpiLevels?:
  boolean` — forwarded to the viewer (see below).
- `markerTooltip?: (m: ResolvedMarker) => string | HTMLElement | null`,
  `onMarkerClick?: (e: MarkerEvent) => void`.
- `onError?: (err: unknown) => void`, `className?`, `style?`.

The explorer owns its own view/cursor state, so it does *not* take `onCursor` /
`onFrame` / `onReady` / `children`. For those, use `<FitsViewer>` below. The real
production usage (probing `collection.json` first, falling back to `fitsgl.json`)
is in `viewer/src/App.tsx`.

## Custom React viewer with `<FitsViewer>`

When you want your own chrome, use the bare `<FitsViewer>` component. It owns a
canvas + the core viewer lifecycle and is driven by a single controlled prop,
`config: ViewerConfig`; high-frequency / one-shot actions go through a `ref`
handle.

```tsx
import { useEffect, useRef, useState } from 'react';
import { FitsViewer } from '@fitsgl/core/react';
import type { FitsViewerHandle } from '@fitsgl/core/react';
import type { ViewerConfig } from '@fitsgl/core';

const manifestUrl = new URL('pyramid/manifest.json', document.baseURI).href;

export function MyViewer() {
  const ref = useRef<FitsViewerHandle>(null);
  const [config] = useState<ViewerConfig>({
    bands: [{ name: 'image', tiles: [manifestUrl] }],
    view: { mode: 'single', band: 'image', colormap: 'viridis' },
    // stretch omitted → auto-stretch to data in view on the first frame
  });

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <FitsViewer
        ref={ref}
        config={config}
        onReady={(h) => h.fitToImage()}
        onCursor={(info) => { /* info?.ra / info?.dec live readout */ }}
        onError={(e) => console.error(e)}
      />
      <button onClick={() => ref.current?.autoStretch()}>Auto-stretch</button>
    </div>
  );
}
```

`FitsViewerProps`:

- `config: ViewerConfig` (required) — the controlled contract. A change to the
  *band set* reloads pyramids + rebuilds; `view` / `colormap` / `stretch` /
  `northUp` changes are applied as live setters.
- `tileOptions?: TilePyramidOptions`, `textureBudget?: number` (GPU texture budget
  per band, core default 200), `hiDpiLevels?: boolean`.
- `onFrame?`, `onCursor?` — fixed at viewer construction (adding `onCursor` where
  there was none takes effect on the next band reload).
- `onMarkerClick?`, `onMarkerHover?`, `markerTooltip?` — hot-swappable.
- `onReady?: (handle: FitsViewerHandle) => void` — fires once the viewer is built
  (and after each band reload).
- `onError?`, `className?`, `style?`, `children?` (rendered over the canvas, e.g.
  a HUD).

`FitsViewerHandle` (via `ref`) — all methods no-op safely before `onReady` fires:

```ts
interface FitsViewerHandle {
  setMarkers(markers: MarkerInput[]): string[];
  addMarkers(markers: MarkerInput[]): string[];
  updateMarker(id: string, patch: MarkerPatch): boolean;
  removeMarker(id: string): boolean;
  clearMarkers(): void;
  autoStretch(pLo?: number, pHi?: number): Promise<AutoStretchResult | null>;
  fitToImage(): void;
  setCenter(x: number, y: number): void;
  setZoom(zoom: number): void;
  getViewer(): FitsViewerCore | null;            // escape hatch to the core viewer
  getPyramids(): ReadonlyMap<string, TilePyramid> | null;
}
```

Markers are deliberately *not* a controlled prop — push them through the handle (a
10–20k-element array prop would diff on every render).

The `./react` subpath also exports the pure config-derivation helpers
(`defaultExplorerState`, `deriveViewerConfig`, `explorerBandsFromConfig`,
`defaultViewFromConfig`, `explorerBandsFromDataset`, `defaultViewFromDataset`) and
re-exports `loadFitsglConfig` / `fitsglConfigFromDataset` so a host using only
this subpath needn't also import the core barrel.

## Vanilla (no framework)

Wire `TilePyramid` + `FitsViewer` by hand. The simplest single-band path
constructs the viewer straight from a `TilePyramid`:

```ts
import { FitsViewer, TilePyramid } from '@fitsgl/core';

const manifestUrl = new URL('pyramid/manifest.json', document.baseURI).href;
const canvas = document.getElementById('view') as HTMLCanvasElement;

const pyramid = await TilePyramid.load(manifestUrl, { useWorker: true });

const viewer = new FitsViewer(canvas, pyramid, {
  textureBudget: 400,
  onFrame: (info) => { /* info.zoom, info.level, info.bounds */ },
  onCursor: (info) => { /* info?.ra, info?.dec, or null on leave */ },
});

viewer.fitToImage();
const auto = await viewer.autoStretch();      // percentile stretch to data in view
viewer.setColormap('magma');                  // a COLORMAP_NAMES value, or a LUT, or null
viewer.setStretchMode('log');                 // a STRETCH_MODES value

// teardown
viewer.destroy();
pyramid.destroy();
```

For multi-band / RGB, build a `RenderSource` from a `ViewerConfig` with
`loadViewerSource`, then hand the source to the viewer. This is the path
`demo/src/main.ts` uses:

```ts
import {
  FitsViewer,
  loadViewerSource,
  type ViewerConfig,
} from '@fitsgl/core';

const config: ViewerConfig = {
  bands: [
    { name: 'f200w', tiles: [url200] },
    { name: 'f356w', tiles: [url356] },
    { name: 'f444w', tiles: [url444] },
  ],
  view: { mode: 'rgb', r: 'f444w', g: 'f356w', b: 'f200w' },
};

const { pyramids, source } = await loadViewerSource(config, { useWorker: true });
const viewer = new FitsViewer(canvas, source, { textureBudget: 400 });

// per-channel limits + a band swap, live:
viewer.setChannelStretch('r', 0, 5);
viewer.setSource(/* a new RenderSource — grid-preserving */);

// teardown owns the pyramids loadViewerSource returned:
viewer.destroy();
for (const p of pyramids.values()) p.destroy();
```

Useful core `FitsViewer` methods (a common subset; all on the instance, also
reachable in React via `handle.getViewer()`):

- `setStretch(min, max)` / `setChannelStretch(role, min, max)` — set the display
  interval (single-band / RGB channel).
- `setStretchMode(mode)` — a `STRETCH_MODES` value (`'linear'`, `'log'`,
  `'asinh'`, `'trilogy'`).
- `setColormap(name | LUT | null)` — single-band colormap.
- `setSource(source)`, `setNorthUp(enabled)`, `setBandWeights(weights)`,
  `applyTrilogy(stats, params?)`.
- `autoStretch(pLo?, pHi?)`, `visibleHistogram(bins?)` — both resolve `null`
  before the first drawn frame.
- `setCenter(x, y)`, `setZoom(zoom)`, `fitToImage()`.
- marker mutation: `setMarkers`, `addMarkers`, `updateMarker`, `removeMarker`,
  `clearMarkers`, `setMarkerHandlers`.
- `get sourceMode` → `'single' | 'rgb' | 'multiband'`; `get isRgb`,
  `get isNorthUp`; `destroy()`.

`TilePyramidOptions` (passed to `TilePyramid.load` / `loadViewerSource` /
`tileOptions`):

- `useWorker?: boolean` — offload decode to a worker pool. Default: on when a
  `Worker` (or a `workerFactory`) is available and you haven't injected a custom
  `rangeFetch`/`fetchImpl`.
- `cacheSize?: number` — decoded-tile (RAM) LRU capacity (default 256).
- `rangeFetch?: RangeFetcher` — custom byte-range fetcher (default
  `httpRangeFetch`). Injecting one forces inline decode unless `useWorker: true`.
- `blobStore?: BlobStore | null` — persistent compressed-tile cache; `null`
  disables it, `undefined` uses IndexedDB when available.
- `poolSize?`, `workerFactory?`, `fetchImpl?`, `fingerprint?`.

`TilePyramid` itself exposes `getTile(level, tileX, tileY, signal?)`,
`prefetchTileIndex(level, tileX, tileY)`, `getManifest()`, and `destroy()`.

## Other useful core exports

A non-exhaustive tour of `@fitsgl/core`:

- **Loaders/validators:** `loadManifest`, `validateManifest`, `resolveLevelUrl`,
  `resolveSupertile`, `SUPPORTED_MANIFEST_VERSION`; `loadDataset`,
  `validateDataset`, `resolveDatasetBandUrl`, `compatibleBands`, `DATASET_VERSION`;
  `loadFitsglConfig`, `validateFitsglConfig`, `resolveFitsglConfig`,
  `fitsglConfigFromDataset`, `FITSGL_SCHEMA_VERSION`; `loadCollection`,
  `validateCollection`, `COLLECTION_SCHEMA_VERSION`; `validateViewerConfig`,
  `renderSourceForView`, `loadViewerSource`.
- **Stretch math:** `percentileRange`, `histogram`, `PERCENTILE_SAMPLE_CAP`,
  `STRETCH_MODES`, `isStretchMode`; the trilogy helpers (`trilogyLevels`,
  `solveTrilogyK`, `combineTrilogyLuminance`, `rainbowWeights`,
  `DEFAULT_TRILOGY_PARAMS`, `MAX_BANDS`, …).
- **Colormaps:** `COLORMAP_NAMES`, `COLORMAP_SIZE`, `isColormapName`,
  `colormapRGB`.
- **WCS:** `parseWcs`, `pixToSky`, `skyToPix`, `formatRA`, `formatDec` (types
  `TanWcs`, `SkyCoord`, `PixelCoord`).
- **Overlays:** `parseCatalogCSV`, `MARKER_SHAPES`, `isMarkerShape`, `parseColor`,
  `CATALOG_VERSION` (types `MarkerInput`, `ResolvedMarker`, `MarkerEvent`, …).
- **Range fetch:** `httpRangeFetch`, type `RangeFetcher`.
- `Camera` and its types, for advanced camera math.

## `@fitsgl/core/internal` — unstable escape hatch

> **Warning:** `@fitsgl/core/internal` is **not** part of the stability contract.
> Anything it re-exports may change in a *minor* release with no semver bump.
> Depend on it only when you knowingly need a building block the narrow public API
> doesn't expose, and pin your version.

It surfaces the lower-level machinery: the RICE codec (`riceDecompress`,
`BitReader`); fpack file parsing and tile decoders (`FpackFile`, `decodeRiceTile`,
`decodeGzip2Tile`, `gunzip`); the decoded-tile cache (`LRUCache`) and the engine
behind the `TilePyramid` façade (`TileEngine`); the persistent compressed-tile
(disk) cache plumbing (`BlobStore`, `openDefaultBlobStore`, `tileBlobKey`,
`fingerprintManifest`, sizing helpers); the decode-worker glue
(`attachDecodeWorker`, `inlineDecoder`, `WorkerPoolDecoder`); the GPU tile manager
and pure tile-selection helpers (`TileManager`, `targetLevel`, `visibleTiles`,
`coarserFallback`, `tileKey`, `TILE_SIZE`, …); render-source internals
(`normalizeSource`, `isRenderSource`, `manifestGridSpec`); and the same-grid gate
(`gridsMatch`, `bandGridSpec`, `GridSpec`).

If you find yourself reaching here for ordinary embedding, the public API probably
already covers it — check the sections above first.
