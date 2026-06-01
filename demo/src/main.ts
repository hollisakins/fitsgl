/**
 * Demo entry point: serve a Phase 1 pyramid as static files, point a
 * `FitsViewer` at its manifest, and wire up the stretch controls + telemetry.
 *
 * The whole point is end-to-end visual verification of Phases 1 → 2a → 2b → 3.
 * To make the byte traffic observable (the "fetched" readout, and a guard that
 * the dev server really honours Range), the tile engine is driven *inline* on
 * the main thread with a counting range fetcher: injecting a `rangeFetch` makes
 * `TilePyramid` skip the worker, so every HTTP range fetch passes through code
 * we can measure. Worker mode is the production default exercised by the
 * Phase 2b tests.
 */

import {
  FitsViewer,
  TilePyramid,
  httpRangeFetch,
  loadDataset,
  resolveDatasetBandUrl,
  parseCatalogCSV,
  formatRA,
  formatDec,
  type DatasetManifest,
  type MarkerInput,
  type RangeFetcher,
  type ResolvedMarker,
  type TilePyramidOptions,
} from 'fits-pyramid';
import { DemoControls } from './controls.js';

/**
 * The viewer's data source. A `dataset.json` beside the manifest (M4) yields a
 * multi-band RGB-capable source; otherwise we fall back to a single
 * `manifest.json` (a real-mosaic build, or a pre-M4 pyramid).
 */
interface DatasetSource {
  kind: 'dataset';
  dataset: DatasetManifest;
  pyramids: Map<string, TilePyramid>;
  representative: TilePyramid;
}
interface SingleSource {
  kind: 'single';
  pyramid: TilePyramid;
}
type SourceData = DatasetSource | SingleSource;

/** Load the dataset (3 bands) if present, else a single-band pyramid. */
async function loadSourceData(baseUrl: string, opts: TilePyramidOptions): Promise<SourceData> {
  const datasetUrl = new URL('pyramid/dataset.json', baseUrl).href;
  let dataset: DatasetManifest | null = null;
  try {
    dataset = await loadDataset(datasetUrl);
  } catch {
    dataset = null; // no/invalid dataset -> single-band fallback below
  }

  if (dataset !== null) {
    const pyramids = new Map<string, TilePyramid>();
    for (const band of dataset.bands) {
      pyramids.set(band.name, await TilePyramid.load(resolveDatasetBandUrl(datasetUrl, band.path), opts));
    }
    const repName = dataset.default_rgb?.r ?? dataset.bands[0].name;
    const representative = pyramids.get(repName) ?? pyramids.get(dataset.bands[0].name);
    if (representative === undefined) throw new Error('dataset has no usable band');
    return { kind: 'dataset', dataset, pyramids, representative };
  }

  const manifestUrl = new URL('pyramid/manifest.json', baseUrl).href;
  return { kind: 'single', pyramid: await TilePyramid.load(manifestUrl, opts) };
}

/** Load the optional overlay catalog served beside the manifest (empty if absent). */
async function loadCatalog(baseUrl: string): Promise<MarkerInput[]> {
  try {
    const res = await fetch(new URL('pyramid/catalog.csv', baseUrl).href);
    if (!res.ok) return [];
    return parseCatalogCSV(await res.text());
  } catch {
    return [];
  }
}

/** Tooltip text for a hovered marker: id, sky position, and flux if present. */
function markerTooltip(m: ResolvedMarker): string {
  const lines = [m.id];
  if (m.ra !== null && m.dec !== null) lines.push(`${formatRA(m.ra)} ${formatDec(m.dec)}`);
  const flux = m.data.flux;
  if (typeof flux === 'number') lines.push(`flux ${flux.toFixed(2)}`);
  return lines.join('\n');
}

// Client-side cache sizes. Two layers protect against re-work when you pan back
// onto a tile (see notes/phase4.md "Reducing fetched bytes"):
//   - GPU_TEXTURE_BUDGET: decoded R32F textures kept resident on the GPU. A tile
//     still on the GPU draws with no getTile call at all (no fetch, no decode).
//   - DECODED_TILE_CACHE: decoded Float32Arrays kept in JS heap. A GPU-evicted
//     tile that's still here re-uploads without re-fetching or re-decoding.
// Keep DECODED_TILE_CACHE > GPU_TEXTURE_BUDGET so GPU eviction rarely forces a
// re-decode. On a CDN the *bytes* come from the browser/edge cache regardless;
// these layers are what avoid the (CDN-immune) decode + upload cost. Each decoded
// 256×256 tile is ~256 KB, so the caps below cost ~100 MB GPU / ~200 MB heap.
const GPU_TEXTURE_BUDGET = 400;
const DECODED_TILE_CACHE = 800;

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`demo: missing #${id} in the page`);
  return found as T;
}

async function main(): Promise<void> {
  const canvas = el<HTMLCanvasElement>('view');
  const status = el('status');

  let bytesFetched = 0;
  const countingRangeFetch: RangeFetcher = async (url, start, endInclusive) => {
    const data = await httpRangeFetch(url, start, endInclusive);
    bytesFetched += data.length;
    return data;
  };

  let source: SourceData;
  try {
    source = await loadSourceData(document.baseURI, {
      useWorker: false,
      rangeFetch: countingRangeFetch,
      cacheSize: DECODED_TILE_CACHE,
    });
  } catch (err) {
    status.textContent =
      `Failed to load the pyramid (${(err as Error).message}).\n` +
      `Did you run \`npm run build-pyramid\` first?`;
    status.classList.add('error');
    status.style.whiteSpace = 'pre-line';
    return;
  }

  // Single-band by default; in dataset mode the representative band is the
  // default red channel (the RGB toggle composites all three).
  const pyramid = source.kind === 'dataset' ? source.representative : source.pyramid;
  const manifest = pyramid.getManifest();

  const controls = new DemoControls(
    {
      minInput: el<HTMLInputElement>('stretch-min'),
      maxInput: el<HTMLInputElement>('stretch-max'),
      autoButton: el<HTMLButtonElement>('auto-btn'),
      stretchSelect: el<HTMLSelectElement>('stretch-mode'),
      colormapSelect: el<HTMLSelectElement>('colormap'),
      northUpCheckbox: el<HTMLInputElement>('northup'),
      markersCheckbox: el<HTMLInputElement>('markers'),
      rgbCheckbox: el<HTMLInputElement>('rgb'),
      bandRSelect: el<HTMLSelectElement>('band-r'),
      bandGSelect: el<HTMLSelectElement>('band-g'),
      bandBSelect: el<HTMLSelectElement>('band-b'),
      channelSelect: el<HTMLSelectElement>('channel'),
      statZoom: el('stat-zoom'),
      statRaDec: el('stat-radec'),
      statCenter: el('stat-center'),
      statLevel: el('stat-level'),
      statCompression: el('stat-compression'),
      statTiles: el('stat-tiles'),
      statFps: el('stat-fps'),
      statBytes: el('stat-bytes'),
      status,
    },
    pyramid,
    manifest,
    () => bytesFetched,
  );

  const viewer = new FitsViewer(canvas, pyramid, {
    textureBudget: GPU_TEXTURE_BUDGET,
    onFrame: (info) => controls.handleFrame(info),
    onCursor: (info) => controls.handleCursor(info),
    markerTooltip,
    onMarkerClick: (e) => {
      const sky = e.marker.ra !== null && e.marker.dec !== null
        ? ` @ ${formatRA(e.marker.ra)} ${formatDec(e.marker.dec)}`
        : '';
      // eslint-disable-next-line no-console
      console.log(`clicked marker ${e.marker.id}${sky}`, e.marker.data);
    },
  });
  controls.setViewer(viewer);

  // In dataset mode, hand the controls the bands so the RGB toggle + pickers work.
  if (source.kind === 'dataset') {
    controls.setDataset(source.dataset, source.pyramids);
  }

  status.classList.add('hidden');

  // Load the optional overlay catalog and hand it to the controls (which toggle
  // it via the "markers" checkbox). Non-fatal if absent.
  controls.setCatalog(await loadCatalog(document.baseURI));

  // Tidy teardown so GL resources, the inline engine, and the HUD timer are
  // released on navigation (beforeunload) and on Vite hot-module replacement
  // (import.meta.hot.dispose), which would otherwise leak across reloads.
  const teardown = (): void => {
    controls.destroy();
    viewer.destroy();
    if (source.kind === 'dataset') {
      for (const p of source.pyramids.values()) p.destroy();
    } else {
      source.pyramid.destroy();
    }
  };
  window.addEventListener('beforeunload', teardown);
  import.meta.hot?.dispose(teardown);
}

main().catch((err: unknown) => {
  const status = document.getElementById('status');
  if (status !== null) {
    status.textContent = `Demo failed to start: ${(err as Error).message}`;
    status.classList.add('error');
    status.classList.remove('hidden');
  }
  // eslint-disable-next-line no-console
  console.error(err);
});
