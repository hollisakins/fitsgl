/**
 * `<FitsExplorer>` — the batteries-included React tier: a `<FitsViewer>` plus a
 * built-in control panel (band / RGB picker, stretch, colormap, limits with live
 * histograms, north-up, overlay) and a status bar. A producer's dataset drops in
 * and is interactive out of the box; a custom host that wants its own chrome uses
 * the bare `<FitsViewer>` instead. (Same package, two entry points.)
 *
 * Design split, mirroring the rest of the repo:
 *  - the **dataset is inventory**; RGB role assignment is live *view state* (the
 *    user picks R/G/B on the fly), constrained only for compositing by grid group.
 *  - stretch *mode* and *limits* (black/white points) are driven IMPERATIVELY via
 *    the viewer's escape-hatch handle, not the controlled `config`: a slider drag
 *    is high-frequency and must not churn React, and a stretch-mode flip must not
 *    re-auto-stretch away the user's manual points. The controlled `config` thus
 *    carries only bands + view + north-up; `<FitsViewer>` auto-stretches a freshly
 *    switched source, which the explorer reads back (`autoStretch` +
 *    `visibleHistogram`) to seed its sliders.
 *  - the pure decision logic (grid grouping, config derivation) lives in
 *    `./explorer-state` so it tests under Node.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

import { FitsViewer } from './index.js';
import type { FitsViewerCore, FitsViewerHandle } from './index.js';
import {
  COLORMAP_NAMES,
  STRETCH_MODES,
  colormapRGB,
  formatDec,
  formatRA,
  parseCatalogCSV,
  type BandHistogram,
  type ColormapName,
  type CursorInfo,
  type MarkerEvent,
  type MarkerInput,
  type ResolvedMarker,
  type StretchMode,
  type TilePyramidOptions,
  type ViewerFrameInfo,
} from '../index.js';
import {
  activeBandNames,
  defaultExplorerState,
  deriveViewerConfig,
  isBandSelectableForRgb,
  type ExplorerBand,
  type ExplorerDefaultView,
  type ExplorerState,
} from './explorer-state.js';

const CH_COLOR = { r: '#ff6b6b', g: '#56d089', b: '#5c8cff' } as const;
type Role = 'r' | 'g' | 'b';

export interface FitsExplorerProps {
  /** The dataset inventory: bands + where their pyramids live + grid groups. */
  bands: ExplorerBand[];
  /** The producer's default view (mode, R/G/B or band, stretch, colormap, north-up). */
  defaultView?: ExplorerDefaultView;
  /** Overlay catalog: pre-parsed markers, or a CSV URL the component fetches. */
  catalog?: MarkerInput[] | { url: string };
  /** Dataset label shown in the status bar. */
  title?: string;
  /** Tile-fetch options forwarded to `<FitsViewer>`. */
  tileOptions?: TilePyramidOptions;
  /** GPU texture budget per band, forwarded to `<FitsViewer>`. */
  textureBudget?: number;
  /** Select pyramid levels at device-pixel resolution, forwarded to `<FitsViewer>`. */
  hiDpiLevels?: boolean;
  /** Built-in popup content for the hovered marker, forwarded to `<FitsViewer>`. */
  markerTooltip?: (m: ResolvedMarker) => string | HTMLElement | null;
  /** Marker click handler, forwarded to `<FitsViewer>`. */
  onMarkerClick?: (e: MarkerEvent) => void;
  /** Loading/construction failure (no WebGL2, bad manifest, grid mismatch). */
  onError?: (err: unknown) => void;
  className?: string;
  style?: CSSProperties;
}

/** Format a data value compactly for the limits readout. */
function fmtVal(v: number): string {
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e4 || a < 1e-2)) return v.toExponential(2);
  return v.toFixed(2);
}

/** A CSS gradient sampling a bundled colormap, for the preview chips. */
function gradientCss(name: ColormapName): string {
  const rgb = colormapRGB(name);
  const n = rgb.length / 3;
  const stops: string[] = [];
  for (let i = 0; i <= 8; i++) {
    const idx = Math.min(n - 1, Math.round((i / 8) * (n - 1)));
    stops.push(`rgb(${rgb[idx * 3]},${rgb[idx * 3 + 1]},${rgb[idx * 3 + 2]}) ${(i / 8) * 100}%`);
  }
  return `linear-gradient(90deg,${stops.join(',')})`;
}

/** Log-scaled histogram bars on a canvas; redraws only when its data changes. */
function Histogram({ counts, color }: { counts: Float32Array; color: string }): JSX.Element {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const cv = ref.current;
    if (cv === null) return;
    const rect = cv.getBoundingClientRect();
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    cv.width = Math.max(1, rect.width * dpr);
    cv.height = Math.max(1, rect.height * dpr);
    const c = cv.getContext('2d');
    if (c === null) return;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, rect.width, rect.height);
    const n = counts.length;
    let mx = 0;
    for (let i = 0; i < n; i++) {
      const v = Math.log1p(counts[i]);
      if (v > mx) mx = v;
    }
    if (mx <= 0) return;
    const bw = rect.width / n;
    c.fillStyle = color;
    for (let i = 0; i < n; i++) {
      const h = (Math.log1p(counts[i]) / mx) * rect.height;
      c.fillRect(i * bw, rect.height - h, Math.max(1, bw - 0.5), h);
    }
  }, [counts, color]);
  return <canvas ref={ref} className="fgl-hist" />;
}

/** A black/white-point control over a band's visible-data histogram. */
function LimitsControl({
  histo,
  value,
  color,
  label,
  onChange,
}: {
  histo: BandHistogram | undefined;
  value: { min: number; max: number } | undefined;
  color: string;
  label: string;
  onChange: (min: number, max: number) => void;
}): JSX.Element {
  if (histo === undefined) {
    return (
      <div className="fgl-dr">
        <div className="fgl-dr-head">
          <span className="fgl-sw" style={{ background: color }} />
          <span className="fgl-dr-nm">{label}</span>
        </div>
        <div className="fgl-dr-scanning">scanning data in view…</div>
      </div>
    );
  }
  const { lo, hi } = histo;
  const span = hi - lo || 1;
  const cur = value ?? { min: lo + span * 0.02, max: lo + span * 0.6 };
  const min = Math.max(lo, Math.min(cur.min, hi));
  const max = Math.max(lo, Math.min(cur.max, hi));
  const step = span / 500;
  const pct = (v: number): number => ((v - lo) / span) * 100;
  return (
    <div className="fgl-dr">
      <div className="fgl-dr-head">
        <span className="fgl-sw" style={{ background: color }} />
        <span className="fgl-dr-nm">{label}</span>
        <span className="fgl-dr-vals">
          {fmtVal(min)} – {fmtVal(max)}
        </span>
      </div>
      <div className="fgl-dr-track">
        <Histogram counts={histo.counts} color={color} />
        <div
          className="fgl-dr-fill"
          style={{ left: `${pct(min)}%`, width: `${Math.max(0, pct(max) - pct(min))}%`, borderColor: color }}
        />
        <input
          type="range"
          className="fgl-range"
          min={lo}
          max={hi}
          step={step}
          value={min}
          onChange={(e) => onChange(Math.min(Number(e.target.value), max - step), max)}
        />
        <input
          type="range"
          className="fgl-range"
          min={lo}
          max={hi}
          step={step}
          value={max}
          onChange={(e) => onChange(min, Math.max(Number(e.target.value), min + step))}
        />
      </div>
    </div>
  );
}

/** The preview-keeping colormap dropdown (single-band mode). */
function ColormapDropdown({
  value,
  onChange,
}: {
  value: ColormapName;
  onChange: (name: ColormapName) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  return (
    <div className="fgl-cm" ref={rootRef}>
      <button type="button" className="fgl-cm-trigger" onClick={() => setOpen((o) => !o)}>
        <span className="fgl-cm-bar" style={{ background: gradientCss(value) }} />
        <span className="fgl-cm-nm">{value}</span>
        <span className="fgl-chev">▾</span>
      </button>
      {open && (
        <div className="fgl-cm-menu">
          {COLORMAP_NAMES.map((name) => (
            <div
              key={name}
              className={`fgl-cm-opt${name === value ? ' on' : ''}`}
              onClick={() => {
                onChange(name);
                setOpen(false);
              }}
            >
              <span className="fgl-cm-bar" style={{ background: gradientCss(name) }} />
              <span className="fgl-cm-nm">{name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The 3×N grid-aware R/G/B picker. */
function RgbGrid({
  bands,
  rgb,
  onPick,
}: {
  bands: ExplorerBand[];
  rgb: { r: string; g: string; b: string };
  onPick: (role: Role, band: string) => void;
}): JSX.Element {
  const cols = `34px repeat(${bands.length}, 1fr)`;
  return (
    <div className="fgl-grid" style={{ gridTemplateColumns: cols }}>
      <div />
      {bands.map((b) => (
        <div key={b.name} className="fgl-bandhead">
          {b.label ?? b.name}
        </div>
      ))}
      {(['r', 'g', 'b'] as const).map((role) => (
        <RgbRow key={role} role={role} bands={bands} rgb={rgb} onPick={onPick} />
      ))}
    </div>
  );
}

function RgbRow({
  role,
  bands,
  rgb,
  onPick,
}: {
  role: Role;
  bands: ExplorerBand[];
  rgb: { r: string; g: string; b: string };
  onPick: (role: Role, band: string) => void;
}): JSX.Element {
  return (
    <>
      <div className="fgl-chlab" style={{ color: CH_COLOR[role] }}>
        <span className="fgl-dot" style={{ background: CH_COLOR[role] }} />
        {role.toUpperCase()}
      </div>
      {bands.map((b) => {
        const on = rgb[role] === b.name;
        const selectable = on || isBandSelectableForRgb(b, bands, rgb);
        return (
          <div key={b.name} className="fgl-cell">
            <button
              type="button"
              className={`fgl-radio${on ? ' on' : ''}${selectable ? '' : ' disabled'}`}
              style={on ? { color: CH_COLOR[role] } : undefined}
              disabled={!selectable}
              aria-label={`${role.toUpperCase()} = ${b.name}`}
              onClick={() => onPick(role, b.name)}
            />
          </div>
        );
      })}
    </>
  );
}

export function FitsExplorer(props: FitsExplorerProps): JSX.Element {
  const { bands, title } = props;
  const handle = useRef<FitsViewerHandle>(null);
  const getViewer = useCallback((): FitsViewerCore | null => handle.current?.getViewer() ?? null, []);

  const [state, setState] = useState<ExplorerState>(() => defaultExplorerState(bands, props.defaultView));
  const [collapsed, setCollapsed] = useState(false);
  const [readyTick, setReadyTick] = useState(0);
  const [cursor, setCursor] = useState<CursorInfo | null>(null);
  const [frame, setFrame] = useState<ViewerFrameInfo | null>(null);
  const [limits, setLimits] = useState<Record<string, { min: number; max: number }>>({});
  const [histos, setHistos] = useState<Record<string, BandHistogram>>({});
  const [markers, setMarkers] = useState<MarkerInput[]>(Array.isArray(props.catalog) ? props.catalog : []);

  useEffect(ensureStyles, []);

  const config = useMemo(() => deriveViewerConfig(bands, state), [bands, state]);

  // Fetch a catalog URL into markers (a pre-parsed array is used as-is).
  useEffect(() => {
    const cat = props.catalog;
    if (cat === undefined || Array.isArray(cat)) return;
    let live = true;
    fetch(cat.url)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`catalog ${r.status}`))))
      .then((text) => {
        if (live) setMarkers(parseCatalogCSV(text));
      })
      .catch(() => {
        /* no overlay if the catalog can't be fetched/parsed */
      });
    return () => {
      live = false;
    };
  }, [props.catalog]);

  // Push markers when the overlay is toggled (and re-push after a reload).
  useEffect(() => {
    const h = handle.current;
    if (h === null || readyTick === 0) return;
    if (state.overlay) h.setMarkers(markers);
    else h.clearMarkers();
  }, [state.overlay, markers, readyTick]);

  // Stretch MODE is imperative: a flip must not re-auto-stretch the manual limits.
  useEffect(() => {
    getViewer()?.setStretchMode(state.stretch);
  }, [state.stretch, readyTick, getViewer]);

  // Seed the limits sliders + histograms from the data in view, after the source
  // changes (or a reload). Deferred to the next drawn frame (autoStretch /
  // visibleHistogram need a frame's level+bounds), via `needSeedRef` + onFrame.
  const viewSig =
    state.mode === 'single' ? `s:${state.band}` : `rgb:${state.rgb.r}|${state.rgb.g}|${state.rgb.b}`;
  const needSeedRef = useRef(true);
  useEffect(() => {
    needSeedRef.current = true;
  }, [viewSig, readyTick]);

  const seed = useCallback(async (): Promise<void> => {
    const v = getViewer();
    if (v === null) return;
    const [auto, hist] = await Promise.all([v.autoStretch(), v.visibleHistogram()]);
    setLimits((prev) => {
      if (auto === null) return prev;
      const next = { ...prev };
      if (auto.mode === 'single') next[state.band] = { min: auto.min, max: auto.max };
      else
        for (const role of ['r', 'g', 'b'] as const) {
          const r = auto[role];
          if (r !== null) next[state.rgb[role]] = { min: r[0], max: r[1] };
        }
      return next;
    });
    setHistos((prev) => {
      if (hist === null) return prev;
      const next = { ...prev };
      if (hist.mode === 'single') next[state.band] = hist.band;
      else {
        if (hist.r !== null) next[state.rgb.r] = hist.r;
        if (hist.g !== null) next[state.rgb.g] = hist.g;
        if (hist.b !== null) next[state.rgb.b] = hist.b;
      }
      return next;
    });
  }, [getViewer, state.mode, state.band, state.rgb.r, state.rgb.g, state.rgb.b]);

  const onFrame = (info: ViewerFrameInfo): void => {
    setFrame((prev) =>
      prev !== null && prev.level === info.level && prev.zoom === info.zoom && prev.northUp === info.northUp
        ? prev
        : info,
    );
    if (needSeedRef.current) {
      needSeedRef.current = false;
      void seed();
    }
  };

  const setLimit = (bandName: string, min: number, max: number, role?: Role): void => {
    setLimits((prev) => ({ ...prev, [bandName]: { min, max } }));
    const v = getViewer();
    if (v === null) return;
    if (role !== undefined) v.setChannelStretch(role, min, max);
    else v.setStretch(min, max);
  };

  const activeBands = activeBandNames(state);
  const activeLabels = activeBands.map((n) => bands.find((b) => b.name === n)?.label ?? n);

  const containerStyle =
    props.style === undefined ? ROOT_STYLE : { ...ROOT_STYLE, ...props.style };

  return (
    <div className={`fgl-explorer${props.className === undefined ? '' : ` ${props.className}`}`} style={containerStyle}>
      <div className="fgl-stage">
        <FitsViewer
          config={config}
          ref={handle}
          tileOptions={props.tileOptions}
          textureBudget={props.textureBudget}
          hiDpiLevels={props.hiDpiLevels}
          markerTooltip={props.markerTooltip}
          onMarkerClick={props.onMarkerClick}
          onCursor={setCursor}
          onFrame={onFrame}
          onReady={() => setReadyTick((t) => t + 1)}
          onError={props.onError}
        >
          <div className={`fgl-win${collapsed ? ' collapsed' : ''}`}>
            <div className="fgl-win-head" onClick={() => setCollapsed((c) => !c)}>
              <span className="fgl-win-ttl">Display</span>
              <span className="fgl-chev">▾</span>
            </div>
            <div className="fgl-win-body">
              {/* layers */}
              <div className="fgl-sec">
                <span className="fgl-cap">Layers</span>
                <div className="fgl-seg">
                  {(['single', 'rgb'] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      aria-pressed={state.mode === m}
                      onClick={() => setState((s) => ({ ...s, mode: m }))}
                    >
                      {m === 'single' ? 'Single' : 'RGB'}
                    </button>
                  ))}
                </div>
                {state.mode === 'single' ? (
                  <div className="fgl-sel" style={{ marginTop: 9 }}>
                    <select
                      value={state.band}
                      onChange={(e) => setState((s) => ({ ...s, band: e.target.value }))}
                    >
                      {bands.map((b) => (
                        <option key={b.name} value={b.name}>
                          {b.label ?? b.name}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <div style={{ marginTop: 11 }}>
                    <RgbGrid
                      bands={bands}
                      rgb={state.rgb}
                      onPick={(role, band) => setState((s) => ({ ...s, rgb: { ...s.rgb, [role]: band } }))}
                    />
                    <div className="fgl-note">RGB requires co-gridded bands — cross-grid filters grey out.</div>
                  </div>
                )}
              </div>

              {/* scaling */}
              <div className="fgl-sec">
                <span className="fgl-cap">Scaling</span>
                <div className="fgl-row">
                  <span className="fgl-cap-inline">Stretch</span>
                  <div className="fgl-sel">
                    <select
                      value={state.stretch}
                      onChange={(e) => setState((s) => ({ ...s, stretch: e.target.value as StretchMode }))}
                    >
                      {STRETCH_MODES.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="fgl-limits">
                  {state.mode === 'single' ? (
                    <LimitsControl
                      histo={histos[state.band]}
                      value={limits[state.band]}
                      color="#e0ad4d"
                      label={bands.find((b) => b.name === state.band)?.label ?? state.band}
                      onChange={(min, max) => setLimit(state.band, min, max)}
                    />
                  ) : (
                    (['r', 'g', 'b'] as const).map((role) => {
                      const bn = state.rgb[role];
                      return (
                        <LimitsControl
                          key={role}
                          histo={histos[bn]}
                          value={limits[bn]}
                          color={CH_COLOR[role]}
                          label={`${role.toUpperCase()} · ${bands.find((b) => b.name === bn)?.label ?? bn}`}
                          onChange={(min, max) => setLimit(bn, min, max, role)}
                        />
                      );
                    })
                  )}
                  <button type="button" className="fgl-auto" onClick={() => void seed()}>
                    Auto-stretch visible
                  </button>
                </div>

                {state.mode === 'single' && (
                  <div className="fgl-row" style={{ marginTop: 11 }}>
                    <span className="fgl-cap-inline">Colormap</span>
                    <ColormapDropdown
                      value={state.colormap}
                      onChange={(name) => setState((s) => ({ ...s, colormap: name }))}
                    />
                  </div>
                )}
              </div>

              {/* view */}
              <div className="fgl-sec">
                <span className="fgl-cap">View</span>
                <div
                  className={`fgl-tg${state.northUp ? ' on' : ''}`}
                  onClick={() => setState((s) => ({ ...s, northUp: !s.northUp }))}
                >
                  <span className="fgl-tx">North up</span>
                  <span className="fgl-switch" />
                </div>
                <div className="fgl-row" />
                <div
                  className={`fgl-tg${state.overlay ? ' on' : ''}${markers.length === 0 ? ' off' : ''}`}
                  onClick={() => markers.length > 0 && setState((s) => ({ ...s, overlay: !s.overlay }))}
                >
                  <span className="fgl-tx">Catalog overlay</span>
                  <span className="fgl-switch" />
                </div>
              </div>

              <div className="fgl-sec">
                <button type="button" className="fgl-reset" onClick={() => handle.current?.fitToImage()}>
                  Fit to image
                </button>
              </div>
            </div>
          </div>
        </FitsViewer>
      </div>

      {/* status bar */}
      <div className="fgl-status">
        <span className="fgl-brand">FITSGL</span>
        <span className="fgl-item">
          <i>field</i>
          <b>{title ?? '—'}</b>
        </span>
        <span className="fgl-div" />
        <span className="fgl-item">
          <i>mode</i>
          <b>{state.mode === 'single' ? 'Single' : 'RGB'}</b>
        </span>
        <span className="fgl-item">
          <i>bands</i>
          <b>{activeLabels.join('·')}</b>
        </span>
        <span className="fgl-item">
          <i>stretch</i>
          <b>{state.stretch}</b>
        </span>
        <span className="fgl-spacer" />
        <span className="fgl-item coord">
          <i>α</i>
          <b>{cursor !== null && cursor.ra !== null ? formatRA(cursor.ra) : '—'}</b>
        </span>
        <span className="fgl-item coord">
          <i>δ</i>
          <b>{cursor !== null && cursor.dec !== null ? formatDec(cursor.dec) : '—'}</b>
        </span>
        <span className="fgl-item">
          <i>zoom</i>
          <b>{frame !== null ? `${frame.zoom.toFixed(2)}×` : '—'}</b>
        </span>
      </div>
    </div>
  );
}

const ROOT_STYLE: CSSProperties = {
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  width: '100%',
  height: '100%',
  background: '#06080d',
};

const STYLE_ID = 'fgl-explorer-styles';
function ensureStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID) !== null) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = STYLE_CSS;
  document.head.appendChild(el);
}

const STYLE_CSS = `
.fgl-explorer{--win:#0e1320;--inset:#080b12;--line:rgba(150,170,210,.11);--line2:rgba(150,170,210,.2);
  --text:#cdd5e3;--dim:#828ca3;--faint:#566073;--gold:#e0ad4d;--gold-d:#7d6630;
  --mono:'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
  color:var(--text);font-family:var(--mono);font-size:12.5px;}
.fgl-explorer *{box-sizing:border-box;}
.fgl-stage{flex:1;position:relative;min-height:0;}
.fgl-win{position:absolute;top:13px;left:13px;width:300px;z-index:5;
  background:color-mix(in srgb,var(--win) 94%,transparent);border:1px solid var(--line2);border-radius:5px;
  backdrop-filter:blur(8px);box-shadow:0 10px 30px rgba(0,0,0,.45);}
.fgl-win-head{display:flex;align-items:center;justify-content:space-between;padding:9px 12px;cursor:pointer;
  user-select:none;border-bottom:1px solid var(--line);}
.fgl-win.collapsed .fgl-win-head{border-bottom:0;}
.fgl-win-ttl{font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--dim);}
.fgl-chev{color:var(--gold);font-size:10px;transition:transform .2s;}
.fgl-win.collapsed .fgl-chev{transform:rotate(-90deg);}
.fgl-win.collapsed .fgl-win-body{display:none;}
.fgl-win-body{max-height:calc(100% - 40px);overflow-y:auto;}
.fgl-sec{padding:13px;border-bottom:1px solid var(--line);}
.fgl-sec:last-child{border-bottom:0;}
.fgl-cap{display:block;font-size:9.5px;letter-spacing:.18em;text-transform:uppercase;color:var(--faint);margin-bottom:9px;}
.fgl-cap-inline{font-size:9.5px;letter-spacing:.18em;text-transform:uppercase;color:var(--faint);min-width:52px;}
.fgl-row{display:flex;align-items:center;gap:9px;}
.fgl-seg{display:flex;gap:2px;background:var(--inset);border:1px solid var(--line);border-radius:4px;padding:2px;}
.fgl-seg button{flex:1;border:0;background:transparent;color:var(--dim);font-family:var(--mono);font-size:11px;
  letter-spacing:.06em;padding:6px 4px;border-radius:3px;cursor:pointer;}
.fgl-seg button:hover{color:var(--text);}
.fgl-seg button[aria-pressed="true"]{background:var(--gold);color:#161003;font-weight:500;}
.fgl-sel{position:relative;flex:1;}
.fgl-sel::after{content:"▾";position:absolute;right:11px;top:50%;transform:translateY(-50%);color:var(--gold);pointer-events:none;font-size:10px;}
.fgl-sel select{width:100%;appearance:none;background:var(--inset);color:var(--text);border:1px solid var(--line2);
  border-radius:4px;padding:8px 11px;font-family:var(--mono);font-size:12px;cursor:pointer;}
.fgl-sel select:focus{outline:none;border-color:var(--gold-d);}
.fgl-grid{display:grid;gap:6px 5px;align-items:center;}
.fgl-bandhead{font-size:9px;color:var(--dim);text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.fgl-chlab{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:600;letter-spacing:.08em;}
.fgl-dot{width:8px;height:8px;border-radius:50%;}
.fgl-cell{display:flex;align-items:center;justify-content:center;}
.fgl-radio{width:16px;height:16px;border-radius:50%;border:1.5px solid var(--line2);cursor:pointer;background:var(--inset);
  padding:0;position:relative;color:var(--gold);}
.fgl-radio:hover{border-color:var(--dim);}
.fgl-radio.on{border-color:currentColor;}
.fgl-radio.on::after{content:"";position:absolute;inset:3px;border-radius:50%;background:currentColor;}
.fgl-radio.disabled{opacity:.16;cursor:not-allowed;}
.fgl-note{margin-top:9px;font-size:9.5px;color:var(--faint);line-height:1.5;}
.fgl-limits{margin-top:11px;}
.fgl-dr{margin-bottom:11px;}
.fgl-dr-head{display:flex;align-items:center;gap:7px;margin-bottom:5px;}
.fgl-sw{width:7px;height:7px;border-radius:2px;}
.fgl-dr-nm{font-size:10.5px;color:var(--text);flex:1;letter-spacing:.03em;}
.fgl-dr-vals{font-size:9.5px;color:var(--dim);font-variant-numeric:tabular-nums;}
.fgl-dr-scanning{font-size:10px;color:var(--faint);padding:6px 0;}
.fgl-dr-track{position:relative;height:32px;}
.fgl-hist{position:absolute;inset:0 0 8px;width:100%;height:24px;border:1px solid var(--line);border-radius:3px;background:var(--inset);}
.fgl-dr-fill{position:absolute;bottom:8px;height:24px;background:rgba(224,173,77,.09);border-left:1px solid var(--gold);border-right:1px solid var(--gold);pointer-events:none;}
.fgl-range{position:absolute;left:0;right:0;bottom:-3px;width:100%;height:16px;margin:0;appearance:none;background:none;pointer-events:none;}
.fgl-range::-webkit-slider-thumb{appearance:none;pointer-events:auto;width:10px;height:17px;border-radius:2px;background:var(--gold);border:1px solid #161003;cursor:ew-resize;}
.fgl-range::-moz-range-thumb{pointer-events:auto;width:10px;height:17px;border-radius:2px;border:1px solid #161003;background:var(--gold);cursor:ew-resize;}
.fgl-auto{width:100%;margin-top:3px;background:transparent;border:1px solid var(--line2);color:var(--dim);font-family:var(--mono);
  font-size:10px;letter-spacing:.12em;text-transform:uppercase;padding:7px;border-radius:4px;cursor:pointer;}
.fgl-auto:hover{border-color:var(--gold-d);color:var(--gold);}
.fgl-cm{position:relative;flex:1;}
.fgl-cm-trigger{display:flex;align-items:center;gap:9px;width:100%;cursor:pointer;background:var(--inset);
  border:1px solid var(--line2);border-radius:4px;padding:6px 9px;}
.fgl-cm-bar{flex:1;height:13px;border-radius:2px;border:1px solid rgba(0,0,0,.3);}
.fgl-cm-nm{font-size:11px;color:var(--text);min-width:54px;text-align:left;}
.fgl-cm-menu{position:absolute;left:0;right:0;top:calc(100% + 4px);z-index:8;background:var(--win);
  border:1px solid var(--line2);border-radius:4px;padding:4px;box-shadow:0 8px 20px rgba(0,0,0,.5);max-height:200px;overflow-y:auto;}
.fgl-cm-opt{display:flex;align-items:center;gap:9px;padding:5px 6px;border-radius:3px;cursor:pointer;}
.fgl-cm-opt:hover{background:rgba(150,170,210,.08);}
.fgl-cm-opt.on{background:rgba(224,173,77,.12);}
.fgl-cm-opt .fgl-cm-nm{color:var(--dim);}
.fgl-cm-opt.on .fgl-cm-nm{color:var(--gold);}
.fgl-tg{display:flex;align-items:center;justify-content:space-between;cursor:pointer;}
.fgl-tg.off{opacity:.4;cursor:not-allowed;}
.fgl-tx{font-size:11.5px;color:var(--text);letter-spacing:.03em;}
.fgl-switch{width:34px;height:19px;border-radius:10px;background:var(--inset);border:1px solid var(--line2);position:relative;transition:.18s;flex:none;}
.fgl-switch::after{content:"";position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:var(--dim);transition:.18s;}
.fgl-tg.on .fgl-switch{background:var(--gold);border-color:var(--gold);}
.fgl-tg.on .fgl-switch::after{left:17px;background:#161003;}
.fgl-reset{width:100%;background:transparent;border:1px solid var(--line2);color:var(--dim);font-family:var(--mono);
  font-size:10px;letter-spacing:.14em;text-transform:uppercase;padding:9px;border-radius:4px;cursor:pointer;}
.fgl-reset:hover{border-color:var(--gold-d);color:var(--gold);}
.fgl-status{flex:none;height:29px;display:flex;align-items:center;background:#080b12;border-top:1px solid var(--line2);
  padding:0 12px;font-size:11px;overflow:hidden;white-space:nowrap;}
.fgl-brand{color:var(--gold);font-weight:600;letter-spacing:.16em;font-size:10.5px;}
.fgl-item{display:flex;align-items:center;gap:6px;padding:0 13px;}
.fgl-item i{font-style:normal;color:var(--faint);font-size:9px;letter-spacing:.14em;text-transform:uppercase;}
.fgl-item b{font-weight:500;color:var(--text);font-variant-numeric:tabular-nums;letter-spacing:.02em;}
.fgl-item.coord b{min-width:92px;display:inline-block;}
.fgl-div{width:1px;height:14px;background:var(--line2);}
.fgl-spacer{flex:1;}
`;

export default FitsExplorer;
