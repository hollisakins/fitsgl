import { useEffect, useMemo, useRef, useState } from 'react';
import { FitsViewer, type FitsViewerHandle } from 'fits-pyramid/react';
import {
  COLORMAP_NAMES,
  STRETCH_MODES,
  formatDec,
  formatRA,
  loadDataset,
  parseCatalogCSV,
  resolveDatasetBandUrl,
  type BandConfig,
  type ColormapName,
  type CursorInfo,
  type DatasetManifest,
  type MarkerInput,
  type ResolvedMarker,
  type StretchMode,
  type ViewerConfig,
  type ViewerFrameInfo,
} from 'fits-pyramid';

/** Where the (shared) pyramid is served — see vite.config.ts. */
const PYRAMID = '/pyramid/';

interface Discovered {
  bands: BandConfig[];
  /** The band shown in single-band mode (the dataset's red channel, or the only band). */
  representative: string;
  /** The dataset's default R/G/B triple, or null for a single-band pyramid. */
  rgb: { r: string; g: string; b: string } | null;
  catalog: MarkerInput[];
}

/**
 * Find what's on disk: a multi-band `dataset.json` (RGB-capable) or a single
 * `manifest.json`, plus an optional `catalog.csv`. Mirrors the vanilla demo's
 * discovery, but hands the result to React state instead of wiring the viewer.
 */
async function discover(): Promise<Discovered> {
  const base = new URL(PYRAMID, document.baseURI).href;
  const datasetUrl = base + 'dataset.json';
  let dataset: DatasetManifest | null = null;
  try {
    dataset = await loadDataset(datasetUrl);
  } catch {
    dataset = null; // no/invalid dataset -> single-band fallback
  }

  let bands: BandConfig[];
  let representative: string;
  let rgb: Discovered['rgb'] = null;
  if (dataset !== null) {
    bands = dataset.bands.map((b) => ({ name: b.name, tiles: [resolveDatasetBandUrl(datasetUrl, b.path)] }));
    representative = dataset.default_rgb?.r ?? dataset.bands[0].name;
    rgb = dataset.default_rgb ?? null;
  } else {
    representative = 'image';
    bands = [{ name: 'image', tiles: [base + 'manifest.json'] }];
  }

  let catalog: MarkerInput[] = [];
  try {
    const res = await fetch(base + 'catalog.csv');
    if (res.ok) catalog = parseCatalogCSV(await res.text());
  } catch {
    catalog = [];
  }

  return { bands, representative, rgb, catalog };
}

function tooltip(m: ResolvedMarker): string {
  const lines = [m.id];
  if (m.ra !== null && m.dec !== null) lines.push(`${formatRA(m.ra)} ${formatDec(m.dec)}`);
  const flux = m.data.flux;
  if (typeof flux === 'number') lines.push(`flux ${flux.toFixed(2)}`);
  return lines.join('\n');
}

export function App() {
  const handle = useRef<FitsViewerHandle>(null);
  const [data, setData] = useState<Discovered | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Bumped on each onReady (initial + every band reload) so markers re-push. */
  const [readyTick, setReadyTick] = useState(0);

  // Controlled display state — every change rebuilds `config` below, and the
  // component routes it to the cheapest viewer call.
  const [stretchMode, setStretchMode] = useState<StretchMode>('asinh');
  const [colormap, setColormap] = useState<ColormapName | 'gray'>('gray');
  const [northUp, setNorthUp] = useState(true);
  const [rgbOn, setRgbOn] = useState(false);
  const [markersOn, setMarkersOn] = useState(false);

  // Telemetry surfaced from the viewer's callbacks.
  const [cursor, setCursor] = useState<CursorInfo | null>(null);
  const [frame, setFrame] = useState<ViewerFrameInfo | null>(null);

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

  const config = useMemo<ViewerConfig | null>(() => {
    if (data === null) return null;
    const view: ViewerConfig['view'] =
      rgbOn && data.rgb !== null
        ? { mode: 'rgb', r: data.rgb.r, g: data.rgb.g, b: data.rgb.b }
        : {
            mode: 'single',
            band: data.representative,
            colormap: colormap === 'gray' ? undefined : colormap,
          };
    // `stretch.range`/`channels` omitted -> the component auto-stretches to the
    // data in view on the first frame (and after a mode switch).
    return { bands: data.bands, view, stretch: { mode: stretchMode }, northUp };
  }, [data, rgbOn, colormap, stretchMode, northUp]);

  // The live marker push — the imperative half of D12 (the CAMPFIRE path). Driven
  // off `readyTick` so it re-applies after a reload rebuilds the viewer.
  useEffect(() => {
    const h = handle.current;
    if (h === null || data === null || readyTick === 0) return;
    if (markersOn) h.setMarkers(data.catalog);
    else h.clearMarkers();
  }, [markersOn, data, readyTick]);

  if (error !== null) return <div className="overlay error">Failed to load:{'\n'}{error}</div>;
  if (data === null || config === null) return <div className="overlay">Loading…</div>;

  return (
    <div className="app">
      <header className="controls">
        <strong>FitsGL · React</strong>
        <label>
          Stretch
          <select value={stretchMode} onChange={(e) => setStretchMode(e.target.value as StretchMode)}>
            {STRETCH_MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label>
          Colormap
          <select
            value={colormap}
            disabled={rgbOn}
            onChange={(e) => setColormap(e.target.value as ColormapName | 'gray')}
          >
            <option value="gray">gray</option>
            {COLORMAP_NAMES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input type="checkbox" checked={northUp} onChange={(e) => setNorthUp(e.target.checked)} /> North-up
        </label>
        <label title={data.rgb === null ? 'no R/G/B triple in dataset.json' : 'composite the default R/G/B bands'}>
          <input
            type="checkbox"
            checked={rgbOn}
            disabled={data.rgb === null}
            onChange={(e) => setRgbOn(e.target.checked)}
          />{' '}
          RGB
        </label>
        <label>
          <input
            type="checkbox"
            checked={markersOn}
            disabled={data.catalog.length === 0}
            onChange={(e) => setMarkersOn(e.target.checked)}
          />{' '}
          Markers ({data.catalog.length})
        </label>
        <button type="button" onClick={() => void handle.current?.autoStretch()}>
          Auto-stretch
        </button>
        <button type="button" onClick={() => handle.current?.fitToImage()}>
          Fit
        </button>
      </header>

      <main className="viewer-wrap">
        <FitsViewer
          config={config}
          ref={handle}
          tileOptions={{ useWorker: false }}
          onReady={() => setReadyTick((t) => t + 1)}
          onError={(e) => setError(e instanceof Error ? e.message : String(e))}
          onCursor={setCursor}
          onFrame={setFrame}
          markerTooltip={tooltip}
          onMarkerClick={(e) => console.log('marker click', e.marker.id, e.marker.data)}
        />
      </main>

      <footer className="status">
        <span>
          {frame !== null
            ? `zoom ${frame.zoom.toFixed(2)}× · level ${frame.level} · ${frame.visibleTileCount} tiles · ${frame.northUp ? 'N-up' : 'raw'}`
            : '—'}
        </span>
        <span>
          {cursor !== null && cursor.ra !== null && cursor.dec !== null
            ? `${formatRA(cursor.ra)} ${formatDec(cursor.dec)}`
            : ''}
        </span>
      </footer>
    </div>
  );
}
