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

import { FitsViewer, TilePyramid, httpRangeFetch, type RangeFetcher } from 'fits-pyramid';
import { DemoControls } from './controls.js';

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

  // Absolute URL so the library can resolve per-level filenames against it
  // (`new URL(filename, manifestUrl)` requires an absolute base).
  const manifestUrl = new URL('pyramid/manifest.json', document.baseURI).href;

  let bytesFetched = 0;
  const countingRangeFetch: RangeFetcher = async (url, start, endInclusive) => {
    const data = await httpRangeFetch(url, start, endInclusive);
    bytesFetched += data.length;
    return data;
  };

  let pyramid: TilePyramid;
  try {
    pyramid = await TilePyramid.load(manifestUrl, {
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

  const manifest = pyramid.getManifest();

  const controls = new DemoControls(
    {
      minInput: el<HTMLInputElement>('stretch-min'),
      maxInput: el<HTMLInputElement>('stretch-max'),
      autoButton: el<HTMLButtonElement>('auto-btn'),
      statZoom: el('stat-zoom'),
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
  });
  controls.setViewer(viewer);

  status.classList.add('hidden');

  // Tidy teardown so GL resources, the inline engine, and the HUD timer are
  // released on navigation (beforeunload) and on Vite hot-module replacement
  // (import.meta.hot.dispose), which would otherwise leak across reloads.
  const teardown = (): void => {
    controls.destroy();
    viewer.destroy();
    pyramid.destroy();
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
