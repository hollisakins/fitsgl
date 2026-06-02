import { useEffect, useState } from 'react';
import { FitsExplorer } from 'fits-pyramid/react';
import {
  fitsglConfigFromDataset,
  formatDec,
  formatRA,
  loadDataset,
  type FitsglConfig,
  type ResolvedMarker,
} from 'fits-pyramid';

/** Where the (shared) pyramid is served — see vite.config.ts. */
const PYRAMID = '/pyramid/';

/**
 * Build the producer contract (`FitsglConfig`) for what's on disk and hand it to
 * `<FitsExplorer config>`.
 *
 * Today the pyramid ships a legacy `dataset.json`, so we bridge it with
 * `fitsglConfigFromDataset` (grid groups via the authoritative `gridsMatch`,
 * `default_rgb` -> default view). When `fitsgl build` starts emitting `fitsgl.json`,
 * this becomes a one-liner: `await loadFitsglConfig(base + 'fitsgl.json')`.
 *
 * This is the first real consumer of the contract: `<FitsExplorer>` owns the view
 * state, so the demo no longer reconstructs a `ViewerConfig` or wires its own UI.
 */
async function discover(): Promise<FitsglConfig> {
  const base = new URL(PYRAMID, document.baseURI).href;
  const datasetUrl = base + 'dataset.json';
  const catalog = { url: base + 'catalog.csv' };
  try {
    const dataset = await loadDataset(datasetUrl);
    const config = fitsglConfigFromDataset(dataset, datasetUrl);
    return { ...config, dataset: { ...config.dataset, title: 'FitsGL · demo', catalog } };
  } catch {
    // No/invalid dataset.json -> single-band pyramid.
    return {
      schemaVersion: 1,
      dataset: {
        name: 'demo',
        title: 'FitsGL · demo',
        bands: [{ name: 'image', tiles: [base + 'manifest.json'], grid: { group: 0 } }],
        catalog,
      },
      defaultView: { mode: 'single' },
    };
  }
}

function tooltip(m: ResolvedMarker): string {
  const lines = [m.id];
  if (m.ra !== null && m.dec !== null) lines.push(`${formatRA(m.ra)} ${formatDec(m.dec)}`);
  const flux = m.data.flux;
  if (typeof flux === 'number') lines.push(`flux ${flux.toFixed(2)}`);
  return lines.join('\n');
}

export function App() {
  const [config, setConfig] = useState<FitsglConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    discover()
      .then((c) => {
        if (live) setConfig(c);
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
        Failed to load:{'\n'}
        {error}
      </div>
    );
  if (config === null) return <div className="overlay">Loading…</div>;

  return (
    <FitsExplorer
      config={config}
      tileOptions={{ useWorker: false }}
      markerTooltip={tooltip}
      onError={(e) => setError(e instanceof Error ? e.message : String(e))}
    />
  );
}
