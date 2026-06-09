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
 * first and fall back to `fitsgl.json` on a 404. Both URLs resolve against
 * `document.baseURI` (not the origin) so the page works deployed under any subpath;
 * `loadFitsglConfig` then resolves the band/catalog URLs relative to the config's URL.
 */
const COLLECTION_URL = new URL('collection.json', document.baseURI).href;
const CONFIG_URL = new URL('fitsgl.json', document.baseURI).href;

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
  if (state.kind === 'collection') return <CollectionPicker collection={state.collection} />;

  return (
    <FitsExplorer
      config={state.config}
      tileOptions={TILE_OPTIONS}
      markerTooltip={tooltip}
      onError={(e) => setError(e instanceof Error ? e.message : String(e))}
    />
  );
}
