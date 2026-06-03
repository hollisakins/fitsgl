import { useEffect, useState } from 'react';
import { FitsExplorer } from 'fits-pyramid/react';
import {
  formatDec,
  formatRA,
  loadFitsglConfig,
  type FitsglConfig,
  type ResolvedMarker,
} from 'fits-pyramid';

/**
 * Load the producer contract (`fitsgl.json`) sitting next to this page and hand it
 * to `<FitsExplorer config>`. The config URL is resolved against `document.baseURI`
 * (not the origin) so the viewer works deployed under any subpath; `loadFitsglConfig`
 * then resolves the band/catalog URLs inside it relative to the config's own URL.
 */
const CONFIG_URL = new URL('fitsgl.json', document.baseURI).href;

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
    loadFitsglConfig(CONFIG_URL)
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
        Failed to load {CONFIG_URL}:{'\n'}
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
