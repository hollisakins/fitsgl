import { useEffect, useState } from 'react';
import { FitsExplorer } from '@fitsgl/core/react';
import {
  formatDec,
  formatRA,
  loadCollection,
  loadFitsglConfig,
  type Collection,
  type FitsglConfig,
  type ResolvedMarker,
  type TilePyramidOptions,
  type WorkerLike,
} from '@fitsgl/core';
import DecodeWorker from '@fitsgl/core/worker?worker';
import { CollectionPicker } from './CollectionPicker.js';

/**
 * Decode-worker wiring. The core's default factory does
 * `new Worker(new URL('../worker.js', import.meta.url))`, which resolves against
 * the BUILT chunk's URL — a file that doesn't exist in this bundled site, which
 * is why this app historically passed `useWorker: false` and decoded every tile
 * on the main thread (the single biggest source of pan/zoom jank). Importing the
 * worker through Vite's `?worker` instead makes Vite emit it as its own chunk
 * and hand back a constructor with the correct URL in both dev and build, under
 * any deploy subpath (relative `base`). The cast mirrors the core's own
 * `as WorkerLike` (a real Worker satisfies the protocol at runtime; only its
 * `onmessage` parameter type is wider). Module scope: one stable options object.
 */
const TILE_OPTIONS: TilePyramidOptions = {
  workerFactory: (): WorkerLike => new DecodeWorker() as WorkerLike,
};

/**
 * Resolve what this page is. A deploy ROOT (bucket prefix "") ships a
 * `collection.json` → render the field picker; a FIELD dir ships a `fitsgl.json` →
 * render the viewer. They never coexist in one directory, so probe `collection.json`
 * first and fall back to `fitsgl.json` on a 404. Both URLs resolve against the
 * dataset base (see `datasetBaseUrl`) — in the vendored production bundle that is
 * always `document.baseURI`, so the page works deployed under any subpath;
 * `loadFitsglConfig` then resolves the band/catalog URLs relative to the config's URL.
 */

/**
 * The dataset directory this page reads.
 *
 * Production (the vendored bundle `fitsgl build` ships next to a dataset):
 * always `document.baseURI` — the config sits beside index.html, and no runtime
 * override exists, so a shipped site's data source cannot be swapped by a
 * crafted link.
 *
 * Dev/preview builds — a build made with `VITE_FITSGL_DATASET` set (e.g. the
 * Vercel preview app, see docs/dev-preview.md) — instead default to that URL and
 * honor a runtime `?dataset=<url>` override, so one deployment can view any
 * public dataset (including a bucket subdirectory) without rebuilding. The value
 * may be the dataset DIRECTORY or a direct pointer to its
 * `fitsgl.json`/`collection.json`; both normalize to the directory.
 */
function datasetBaseUrl(): string {
  const envBase = (import.meta.env.VITE_FITSGL_DATASET as string | undefined) ?? '';
  if (envBase === '') return document.baseURI;
  const param = new URLSearchParams(window.location.search).get('dataset');
  const chosen = param !== null && param !== '' ? param : envBase;
  const dir = chosen.replace(/(?:fitsgl|collection)\.json$/, '');
  // Trailing slash so relative resolution (config → band manifests → tiles)
  // treats the base as a directory, not a file.
  return dir.endsWith('/') ? dir : `${dir}/`;
}

const DATASET_BASE = datasetBaseUrl();
/** Whether a dev/preview dataset override is active (never in the vendored bundle). */
const DATASET_OVERRIDE = DATASET_BASE !== document.baseURI;
const COLLECTION_URL = new URL('collection.json', DATASET_BASE).href;
const CONFIG_URL = new URL('fitsgl.json', DATASET_BASE).href;

/**
 * Field-card link target when the dataset override is active: stay on THIS app
 * and swap the `?dataset=` param to the field's subdirectory, instead of the
 * production-relative `<name>/` navigation (which would leave the preview app).
 */
function overrideFieldHref(name: string): string {
  const target = new URL(`${encodeURIComponent(name)}/`, DATASET_BASE).href;
  const u = new URL(window.location.href);
  u.searchParams.set('dataset', target);
  return `${u.pathname}${u.search}`;
}

function tooltip(m: ResolvedMarker): string {
  const lines = [m.id];
  if (m.ra !== null && m.dec !== null) lines.push(`${formatRA(m.ra)} ${formatDec(m.dec)}`);
  const flux = m.data.flux;
  if (typeof flux === 'number') lines.push(`flux ${flux.toFixed(2)}`);
  return lines.join('\n');
}

type Resolved =
  | { kind: 'collection'; collection: Collection }
  | { kind: 'field'; config: FitsglConfig };

export function App() {
  const [state, setState] = useState<Resolved | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    // Probe the collection manifest first. `loadCollection` returns null when there
    // is none here (a field dir) → fall back to its fitsgl.json (today's behavior);
    // it only rejects on a present-but-malformed collection.json, so a broken root
    // surfaces its real error instead of a misleading fitsgl.json 404.
    loadCollection(COLLECTION_URL)
      .then((collection) => {
        if (collection !== null) {
          if (live) setState({ kind: 'collection', collection });
          return;
        }
        return loadFitsglConfig(CONFIG_URL).then((config) => {
          if (live) setState({ kind: 'field', config });
        });
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, []);

  if (error !== null)
    return (
      <div className="overlay error">
        Failed to load this FitsGL page:{'\n'}
        {error}
      </div>
    );
  if (state === null) return <div className="overlay">Loading…</div>;
  if (state.kind === 'collection')
    return (
      <CollectionPicker
        collection={state.collection}
        fieldHref={DATASET_OVERRIDE ? overrideFieldHref : undefined}
      />
    );

  return (
    <FitsExplorer
      config={state.config}
      tileOptions={TILE_OPTIONS}
      markerTooltip={tooltip}
      onError={(e) => setError(e instanceof Error ? e.message : String(e))}
    />
  );
}
