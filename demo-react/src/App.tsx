import { useEffect, useState } from 'react';
import {
  FitsExplorer,
  defaultViewFromDataset,
  explorerBandsFromDataset,
  type ExplorerBand,
  type ExplorerDefaultView,
} from 'fits-pyramid/react';
import { formatDec, formatRA, loadDataset, type ResolvedMarker } from 'fits-pyramid';

/** Where the (shared) pyramid is served — see vite.config.ts. */
const PYRAMID = '/pyramid/';

interface Discovered {
  bands: ExplorerBand[];
  defaultView: ExplorerDefaultView;
  catalogUrl: string;
}

/**
 * Find what's on disk and hand it to `<FitsExplorer>` as the contract-shaped
 * inventory + default view: a multi-band `dataset.json` becomes grouped
 * `ExplorerBand`s (grid groups via the authoritative `gridsMatch`) with the
 * dataset's `default_rgb` as the default view; a lone `manifest.json` is the
 * single-band fallback. The catalog is passed as a URL the component fetches.
 *
 * This is the first real consumer of the producer contract: the explorer owns the
 * view state (band/RGB/stretch/colormap), so the demo no longer reconstructs a
 * `ViewerConfig` or wires its own controls.
 */
async function discover(): Promise<Discovered> {
  const base = new URL(PYRAMID, document.baseURI).href;
  const datasetUrl = base + 'dataset.json';
  const catalogUrl = base + 'catalog.csv';
  try {
    const dataset = await loadDataset(datasetUrl);
    return {
      bands: explorerBandsFromDataset(dataset, datasetUrl),
      defaultView: defaultViewFromDataset(dataset),
      catalogUrl,
    };
  } catch {
    // No/invalid dataset.json -> single-band pyramid.
    return {
      bands: [{ name: 'image', label: 'image', tiles: [base + 'manifest.json'], gridGroup: 0 }],
      defaultView: { mode: 'single' },
      catalogUrl,
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
  const [data, setData] = useState<Discovered | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    discover()
      .then((d) => {
        if (live) setData(d);
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
  if (data === null) return <div className="overlay">Loading…</div>;

  return (
    <FitsExplorer
      bands={data.bands}
      defaultView={data.defaultView}
      catalog={{ url: data.catalogUrl }}
      title="FitsGL · demo"
      tileOptions={{ useWorker: false }}
      markerTooltip={tooltip}
      onError={(e) => setError(e instanceof Error ? e.message : String(e))}
    />
  );
}
