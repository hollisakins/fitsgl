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

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  SVGProps,
} from 'react';

import { FitsViewer } from './index.js';
import type { FitsViewerCore, FitsViewerHandle } from './index.js';
// Imported directly (not via ./index.js) to avoid a load-order TDZ — index.tsx
// re-exports this binding *after* the `./explorer` re-export it pulls in here.
import { FitsLoadingField } from './loading-field.js';
import {
  COLORMAP_NAMES,
  STRETCH_MODES,
  MAX_BANDS,
  applyStretch,
  colormapRGB,
  formatDec,
  formatRA,
  formatSeparation,
  parseCatalogCSV,
  parseSkyCoord,
  pixToSky,
  skyToPix,
  type BandHistogram,
  type BandWeight,
  type ColormapName,
  type CursorInfo,
  type FitsglConfig,
  type MarkerEvent,
  type MarkerInput,
  type PointerTool,
  type ResolvedMarker,
  type StretchMode,
  type TilePyramidOptions,
  type TrilogyParams,
  type TrilogyStats,
  type ViewerFrameInfo,
} from '../index.js';
import {
  activeBandNames,
  bandRailModel,
  clampInspectorWidth,
  defaultExplorerState,
  defaultViewFromConfig,
  deriveViewerConfig,
  explorerBandsFromConfig,
  groupBands,
  hasZscalePreset,
  isBandSelectableForRgb,
  isTrilogyComposite,
  parseLayoutState,
  rainbowAction,
  rgbActiveGroup,
  serializeLayoutState,
  trilogyComposite,
  INSPECTOR_MAX_WIDTH,
  INSPECTOR_MIN_WIDTH,
  type BandRailModel,
  type ExplorerBand,
  type ExplorerDefaultView,
  type ExplorerState,
  type LayoutState,
  type PanelId,
  type PointerToolMode,
} from './explorer-state.js';
import { bandsSignature, viewSignature } from './plan.js';
import { buildShareUrl, decodeShareHash, type ShareState } from './share-url.js';
import { drawGraticule } from './graticule.js';
import { drawRuler, measureRuler, type RulerGeometry } from './ruler.js';

/** Merge a decoded shared view state onto a base explorer state, validating each
 *  field against the loaded bands / known modes so a stale or hostile link can't
 *  produce an invalid state. The camera (`c`) is applied separately, after load. */
function applyShareToState(
  base: ExplorerState,
  u: ShareState,
  bands: ExplorerBand[],
): ExplorerState {
  const hasBand = (n: string | undefined): n is string =>
    n !== undefined && bands.some((b) => b.name === n);
  const next: ExplorerState = { ...base };
  if (u.m === 'single' || u.m === 'rgb') next.mode = u.m;
  if (hasBand(u.b)) next.band = u.b;
  if (u.rgb !== undefined && u.rgb.every(hasBand)) {
    next.rgb = { r: u.rgb[0], g: u.rgb[1], b: u.rgb[2] };
  }
  if (u.s !== undefined && (STRETCH_MODES as readonly string[]).includes(u.s)) {
    next.stretch = u.s as StretchMode;
  }
  if (u.cm !== undefined && (COLORMAP_NAMES as readonly string[]).includes(u.cm)) {
    next.colormap = u.cm as ColormapName;
  }
  if (u.n === 0 || u.n === 1) next.northUp = u.n === 1;
  if (u.g === 0 || u.g === 1) next.graticule = u.g === 1;
  return next;
}

const CH_COLOR = { r: '#ff6b6b', g: '#56d089', b: '#5c8cff' } as const;
type Role = 'r' | 'g' | 'b';

/** Global localStorage key for the inspector/shell layout chrome (width, collapse,
 *  shelve). One key, shared across datasets — a workspace set up once carries over. */
const LAYOUT_KEY = 'fitsgl:layout';
/** Viewport width at/below which the inspector auto-shelves (overlay on open). */
const NARROW_QUERY = '(max-width: 640px)';

/** Read the persisted layout chrome, tolerating SSR / no-localStorage / quota. */
function readLayoutRaw(): string | null {
  try {
    if (typeof window === 'undefined' || window.localStorage == null) return null;
    return window.localStorage.getItem(LAYOUT_KEY);
  } catch {
    return null;
  }
}

export interface FitsExplorerProps {
  /** Turnkey: a producer `FitsglConfig` (e.g. from `loadFitsglConfig`). Supplies
   *  bands + default view + catalog + title; takes precedence over the loose props. */
  config?: FitsglConfig;
  /** The dataset inventory (when not using `config`): bands + pyramids + grid groups. */
  bands?: ExplorerBand[];
  /** The producer's default view (mode, R/G/B or band, stretch, colormap, north-up). */
  defaultView?: ExplorerDefaultView;
  /** Overlay catalog: pre-parsed markers, or a CSV URL the component fetches. */
  catalog?: MarkerInput[] | { url: string };
  /** Dataset label shown in the status bar (overrides `config.dataset.title`). */
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

/** A horizontal colorbar (single-band): the colormap gradient (linear in stretched
 *  output) with data-value ticks placed through the stretch curve, so a glance maps
 *  colour → value. Returns null for a degenerate range. */
function Colorbar({
  min,
  max,
  mode,
  colormap,
}: {
  min: number;
  max: number;
  mode: StretchMode;
  colormap: ColormapName;
}): JSX.Element | null {
  if (!(max > min)) return null;
  const N = 5;
  const ticks = Array.from({ length: N }, (_, i) => {
    const v = min + ((max - min) * i) / (N - 1);
    const x = Math.min(1, Math.max(0, applyStretch((v - min) / (max - min), mode)));
    return { v, x };
  });
  return (
    <div className="fgl-cbar">
      <div className="fgl-cbar-strip" style={{ background: gradientCss(colormap) }} />
      <div className="fgl-cbar-axis">
        {ticks.map((t, i) => (
          <span
            key={i}
            className="fgl-cbar-tick"
            style={{ left: `${t.x * 100}%`, transform: i === 0 ? 'none' : i === N - 1 ? 'translateX(-100%)' : 'translateX(-50%)' }}
          >
            {fmtVal(t.v)}
          </span>
        ))}
      </div>
    </div>
  );
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

/** A compact numeric input for a stretch limit: commits on blur/Enter, and re-syncs
 *  to the prop while not being edited (so a slider drag updates the shown value). */
function NumField({
  value,
  onCommit,
  title,
}: {
  value: number;
  onCommit: (v: number) => void;
  title: string;
}): JSX.Element {
  const [text, setText] = useState('');
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(String(Number(value.toPrecision(6))));
  }, [value, editing]);
  const commit = (): void => {
    const v = Number(text);
    if (Number.isFinite(v)) onCommit(v);
    setEditing(false);
  };
  return (
    <input
      className="fgl-num"
      type="text"
      inputMode="decimal"
      spellCheck={false}
      title={title}
      value={text}
      onFocus={() => setEditing(true)}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
    />
  );
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
          <NumField value={min} title="black point" onCommit={(v) => onChange(Math.min(v, max), max)} />
          <span className="fgl-dr-dash">–</span>
          <NumField value={max} title="white point" onCommit={(v) => onChange(min, Math.max(v, min))} />
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

/** One labelled trilogy knob; `log` maps the slider over `10^value` decades. */
function TriSlider({
  label,
  value,
  min,
  max,
  step,
  log = false,
  fmt,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  log?: boolean;
  fmt: (v: number) => string;
  onChange: (v: number) => void;
}): JSX.Element {
  const sliderVal = log ? Math.log10(value) : value;
  return (
    <label className="fgl-tri-row">
      <span className="fgl-tri-lbl">{label}</span>
      <input
        type="range"
        className="fgl-tri-range"
        min={min}
        max={max}
        step={step}
        value={sliderVal}
        onChange={(e) => {
          const sv = Number(e.target.value);
          onChange(log ? Math.pow(10, sv) : sv);
        }}
      />
      <span className="fgl-tri-val">{fmt(value)}</span>
    </label>
  );
}

/**
 * Trilogy knobs (faithful, color-preserving): noise luminance, saturation
 * percent, and the noise/black sigmas. The black/white points (`x0`/`x2`) and
 * the softening are derived from these + the band's precomputed global stats, so
 * there are no manual limit sliders here — moving a knob re-derives instantly.
 */
function TrilogyControls({
  params,
  missing,
  onChange,
}: {
  params: TrilogyParams;
  missing: boolean;
  onChange: (patch: Partial<TrilogyParams>) => void;
}): JSX.Element {
  return (
    <div className="fgl-tri">
      {missing && (
        <div className="fgl-tri-warn">
          No precomputed trilogy stats for these bands — rebuild the dataset for a faithful fit.
        </div>
      )}
      <TriSlider
        label="Noise lum"
        value={params.noiselum}
        min={0.01}
        max={0.8}
        step={0.01}
        fmt={(v) => v.toFixed(2)}
        onChange={(v) => onChange({ noiselum: v })}
      />
      <TriSlider
        label="Saturate %"
        value={params.satpercent}
        min={-3}
        max={0}
        step={0.1}
        log
        fmt={(v) => (v >= 0.01 ? v.toFixed(2) : v.toExponential(0))}
        onChange={(v) => onChange({ satpercent: v })}
      />
      <TriSlider
        label="Noise σ"
        value={params.noisesig}
        min={0}
        max={5}
        step={0.1}
        fmt={(v) => v.toFixed(1)}
        onChange={(v) => onChange({ noisesig: v })}
      />
      <TriSlider
        label="Black σ"
        value={params.noisesig0}
        min={0}
        max={5}
        step={0.1}
        fmt={(v) => v.toFixed(1)}
        onChange={(v) => onChange({ noisesig0: v })}
      />
    </div>
  );
}

/** CSS `rgb(...)` for a band's (R,G,B) weight, so a row's swatch shows its tint. */
function weightSwatch(w: BandWeight): string {
  const c = (x: number): number => Math.round(Math.min(1, Math.max(0, x)) * 255);
  return `rgb(${c(w[0])},${c(w[1])},${c(w[2])})`;
}

/** Clamp a float weight to [0,1]; non-finite collapses to 0. */
const clamp01 = (v: number): number => (Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0);
/** A [0,1] weight as its displayed integer percent 0..100 (tolerant of un-snapped Rainbow values). */
const pctOf = (v: number): number => Math.round(clamp01(v) * 100);
/** Snap a raw float to the 1% grid so the displayed integer percent is always exact. */
const snap01 = (v: number): number => Math.round(clamp01(v) * 100) / 100;

/**
 * `Knob` — a compact audio-plugin-style rotary control for a [0,1] weight.
 *
 * Vertical drag (up = increase) over ~170px spans the full range; an SVG 270°
 * gauge arc (gap at the bottom) fills clockwise in the channel color with a
 * pointer notch at the current angle, and the integer percent (0..100) sits in
 * the center. Drag and keys snap to 1% so the shown integer is exact;
 * externally-set continuous values (e.g. Rainbow) still render via `Math.round`
 * and fill the arc proportionally. Fully controlled — no internal value state —
 * so an external write (Rainbow) is reflected immediately and exactly.
 */
function Knob({
  value,
  color,
  label,
  onChange,
}: {
  value: number;
  color: string;
  label: string;
  onChange: (next: number) => void;
}): JSX.Element {
  const SIZE = 30;
  const STROKE = 3.5;
  const RADIUS = (SIZE - STROKE) / 2;
  const CENTER = SIZE / 2;
  const START_DEG = 225; // lower-left, measured clockwise from 12 o'clock
  const SWEEP_DEG = 270; // 90° dead-zone gap at the bottom
  const TRAVEL_PX = 170; // vertical px spanning the full 0..1 range
  const STEP = 0.01;

  // Drag origin: start clientY + start value + last emitted snapped value.
  const drag = useRef<{ y: number; v: number; last: number } | null>(null);

  const frac = clamp01(value); // arc fill fraction, tolerant of un-snapped input
  const percent = pctOf(value);

  const polar = useCallback(
    (deg: number): [number, number] => {
      const a = ((deg - 90) * Math.PI) / 180;
      return [CENTER + RADIUS * Math.cos(a), CENTER + RADIUS * Math.sin(a)];
    },
    [CENTER, RADIUS],
  );

  const arcPath = useCallback(
    (f: number): string => {
      const span = SWEEP_DEG * Math.max(f, 0.0001);
      const [x0, y0] = polar(START_DEG);
      const [x1, y1] = polar(START_DEG + span);
      const large = span > 180 ? 1 : 0;
      return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${RADIUS} ${RADIUS} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
    },
    [polar, RADIUS],
  );

  const trackPath = arcPath(1);
  const fillPath = arcPath(frac);
  const [nx, ny] = polar(START_DEG + SWEEP_DEG * frac);

  // Emit a raw float, snapped to 1%; dedupe within a drag to cut React churn.
  const emit = useCallback(
    (raw: number): void => {
      const next = snap01(raw);
      const d = drag.current;
      if (d !== null) {
        if (next === d.last) return;
        d.last = next;
      }
      onChange(next);
    },
    [onChange],
  );

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>): void => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      e.currentTarget.focus(); // leave it keyboard-focused for immediate Arrow nudging
      drag.current = { y: e.clientY, v: clamp01(value), last: snap01(value) };
    },
    [value],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>): void => {
      const d = drag.current;
      if (d === null) return;
      const dy = d.y - e.clientY; // up is positive
      const gain = e.shiftKey ? TRAVEL_PX * 4 : TRAVEL_PX; // Shift = 4x fine trim
      emit(d.v + dy / gain);
    },
    [emit],
  );

  const endDrag = useCallback((e: ReactPointerEvent<SVGSVGElement>): void => {
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, []);

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<SVGSVGElement>): void => {
      const coarse = e.shiftKey ? 0.05 : STEP;
      let next: number;
      switch (e.key) {
        case 'ArrowUp':
        case 'ArrowRight':
          next = value + coarse;
          break;
        case 'ArrowDown':
        case 'ArrowLeft':
          next = value - coarse;
          break;
        case 'PageUp':
          next = value + 0.1;
          break;
        case 'PageDown':
          next = value - 0.1;
          break;
        case 'Home':
          next = 0;
          break;
        case 'End':
          next = 1;
          break;
        default:
          return;
      }
      e.preventDefault();
      onChange(snap01(next));
    },
    [value, onChange],
  );

  return (
    <svg
      className="fgl-knob"
      width={SIZE}
      height={SIZE}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={`${percent}%`}
      style={{ '--knob-color': color } as CSSProperties}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
    >
      <circle className="fgl-knob-well" cx={CENTER} cy={CENTER} r={RADIUS} />
      <path className="fgl-knob-track" d={trackPath} strokeWidth={STROKE} />
      {frac > 0 ? <path className="fgl-knob-fill" d={fillPath} strokeWidth={STROKE} /> : null}
      <circle className="fgl-knob-notch" cx={nx.toFixed(2)} cy={ny.toFixed(2)} r={1.6} />
      <text className="fgl-knob-num" x={CENTER} y={CENTER} dominantBaseline="central" textAnchor="middle">
        {percent}
      </text>
    </svg>
  );
}

/**
 * Faithful-trilogy weight matrix: every co-gridded band in the active group, each
 * with a participation checkbox and editable R/G/B contribution weights, plus a
 * "Rainbow" button that orders the bands by wavelength and spreads them blue→red.
 * Shown only for an RGB trilogy view; the noise/black knobs (`TrilogyControls`)
 * still apply globally below it. Edits are materialized into `weights`/`weightBands`
 * via `onApply` (the pure composite the parent derives the multiband view from).
 */
function TrilogyWeightMatrix({
  bands,
  state,
  onApply,
  onRainbow,
}: {
  bands: ExplorerBand[];
  state: ExplorerState;
  onApply: (entries: Array<{ band: string; weight: BandWeight }>) => void;
  onRainbow: () => void;
}): JSX.Element {
  const activeGroup = rgbActiveGroup(bands, state.rgb);
  const rows = groupBands(bands, activeGroup);
  const comp = new Map(trilogyComposite(state).map((e) => [e.band, e.weight] as const));
  const atCap = comp.size >= MAX_BANDS;

  const toggle = (name: string): void => {
    const cur = trilogyComposite(state);
    const has = cur.some((e) => e.band === name);
    if (!has && cur.length >= MAX_BANDS) return; // cap: ignore (a note explains)
    const next = has
      ? cur.filter((e) => e.band !== name)
      : [...cur, { band: name, weight: state.weights[name] ?? ([1, 1, 1] as BandWeight) }];
    onApply(next);
  };

  const editWeight = (name: string, ch: 0 | 1 | 2, value: number): void => {
    const v = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
    const cur = trilogyComposite(state);
    const idx = cur.findIndex((e) => e.band === name);
    const prev = idx >= 0 ? cur[idx].weight : state.weights[name] ?? [0, 0, 0];
    const w: BandWeight = ch === 0 ? [v, prev[1], prev[2]] : ch === 1 ? [prev[0], v, prev[2]] : [prev[0], prev[1], v];
    if (idx < 0 && comp.size >= MAX_BANDS) return; // editing would add past the cap
    const next = idx >= 0 ? cur.map((e, i) => (i === idx ? { band: name, weight: w } : e)) : [...cur, { band: name, weight: w }];
    onApply(next);
  };

  return (
    <div className="fgl-wmx">
      <div className="fgl-wmx-head">
        <span className="fgl-wmx-cap">Band weights</span>
        <button type="button" className="fgl-rainbow" onClick={onRainbow}>
          Rainbow
        </button>
      </div>
      <div className="fgl-wmx-cols">
        <span />
        <span />
        <span className="fgl-wmx-hd" style={{ color: CH_COLOR.r }}>R</span>
        <span className="fgl-wmx-hd" style={{ color: CH_COLOR.g }}>G</span>
        <span className="fgl-wmx-hd" style={{ color: CH_COLOR.b }}>B</span>
      </div>
      {rows.map((b) => {
        const on = comp.has(b.name);
        const w = comp.get(b.name) ?? ([0, 0, 0] as BandWeight);
        return (
          <div key={b.name} className={`fgl-wrow${on ? '' : ' off'}`}>
            <input
              type="checkbox"
              className="fgl-wchk"
              checked={on}
              disabled={!on && atCap}
              aria-label={`include ${b.label ?? b.name}`}
              onChange={() => toggle(b.name)}
            />
            <span className="fgl-wlbl">
              <span className="fgl-wswatch" style={{ background: weightSwatch(w) }} />
              {b.label ?? b.name}
            </span>
            {([0, 1, 2] as const).map((ch) => (
              <Knob
                key={ch}
                value={w[ch]}
                color={CH_COLOR[(['r', 'g', 'b'] as const)[ch]]}
                label={`${b.label ?? b.name} ${'RGB'[ch]} weight`}
                onChange={(next) => editWeight(b.name, ch, next)}
              />
            ))}
          </div>
        );
      })}
      <div className="fgl-note">
        Each band is trilogy-stretched, then blended by its R/G/B weights.
        {atCap ? ` Max ${MAX_BANDS} bands per composite.` : ''}
      </div>
    </div>
  );
}

/** One-click colormap swatches (single-band mode): a chip per bundled colormap,
 *  active highlighted. Replaces the old dropdown — colormap is touched every band
 *  flip, so it earns always-visible Tier-1 chrome rather than a click-to-open menu. */
function ColormapSwatches({
  value,
  onChange,
}: {
  value: ColormapName;
  onChange: (name: ColormapName) => void;
}): JSX.Element {
  return (
    <div className="fgl-swatches">
      {COLORMAP_NAMES.map((name) => (
        <button
          key={name}
          type="button"
          className={`fgl-swatch${name === value ? ' on' : ''}`}
          aria-pressed={name === value}
          title={name}
          onClick={() => onChange(name)}
        >
          <span className="fgl-swatch-bar" style={{ background: gradientCss(name) }} />
          <span className="fgl-swatch-nm">{name}</span>
        </button>
      ))}
    </div>
  );
}

/** One-click stretch-mode buttons (DS9 "Scale") — replaces the old <select>. */
function ScaleButtons({
  value,
  onChange,
}: {
  value: StretchMode;
  onChange: (mode: StretchMode) => void;
}): JSX.Element {
  return (
    <div className="fgl-seg fgl-seg-wrap">
      {STRETCH_MODES.map((m) => (
        <button key={m} type="button" aria-pressed={value === m} onClick={() => onChange(m)}>
          {m}
        </button>
      ))}
    </div>
  );
}

/** A labelled on/off switch (View toggles). A real `role="switch"` button so it is
 *  keyboard-reachable + announced; `disabled` dims it and blocks the toggle. */
function ToggleSwitch({
  label,
  on,
  disabled,
  onToggle,
}: {
  label: string;
  on: boolean;
  disabled?: boolean;
  onToggle: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled === true}
      className={`fgl-tg${on ? ' on' : ''}${disabled === true ? ' off' : ''}`}
      onClick={onToggle}
    >
      <span className="fgl-tx">{label}</span>
      <span className="fgl-switch" />
    </button>
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

// ---------------------------------------------------------------------------
// App-shell chrome: left tool rail, top band rail, docked inspector. All inline
// zero-dep SVG (same approach as `Knob`); no component library, no new deps.
// ---------------------------------------------------------------------------

/** Shared attributes for the 16px line icons (stroke = currentColor). */
const ICON: SVGProps<SVGSVGElement> = {
  width: 16,
  height: 16,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  focusable: false,
};
const IconPan = (): JSX.Element => (
  <svg {...ICON}>
    <path d="M8 1.5v13M1.5 8h13" />
    <path d="M8 1.5 6 3.5M8 1.5l2 2M8 14.5l-2-2M8 14.5l2-2M1.5 8l2-2M1.5 8l2 2M14.5 8l-2-2M14.5 8l-2 2" />
  </svg>
);
const IconRuler = (): JSX.Element => (
  <svg {...ICON}>
    <g transform="rotate(45 8 8)">
      <rect x="1.5" y="6" width="13" height="4" rx="0.6" />
      <path d="M4 6v1.6M6.5 6v2.2M9 6v1.6M11.5 6v2.2" />
    </g>
  </svg>
);
const IconFit = (): JSX.Element => (
  <svg {...ICON}>
    <path d="M2.5 5.5v-3h3M13.5 5.5v-3h-3M2.5 10.5v3h3M13.5 10.5v3h-3" />
  </svg>
);
const IconImage = (): JSX.Element => (
  <svg {...ICON}>
    <rect x="2" y="3" width="12" height="10" rx="1.2" />
    <circle cx="5.6" cy="6.4" r="1.1" />
    <path d="M2.5 12.5 6.5 8.5l2.4 2.4 2.2-2.2 3 3" />
  </svg>
);
const IconHeader = (): JSX.Element => (
  <svg {...ICON}>
    <path d="M3 3.5h10M3 6.5h10M3 9.5h7M3 12.5h4" />
  </svg>
);
const IconDisplay = (): JSX.Element => (
  <svg {...ICON}>
    <path d="M3 5h5.5M11.5 5H13M3 11h1.5M7.5 11H13" />
    <circle cx="9.7" cy="5" r="1.6" />
    <circle cx="6" cy="11" r="1.6" />
  </svg>
);
const IconComposite = (): JSX.Element => (
  <svg {...ICON}>
    <circle cx="6" cy="6.4" r="3.3" />
    <circle cx="10" cy="6.4" r="3.3" />
    <circle cx="8" cy="9.8" r="3.3" />
  </svg>
);
const IconView = (): JSX.Element => (
  <svg {...ICON}>
    <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8Z" />
    <circle cx="8" cy="8" r="1.8" />
  </svg>
);

/** One left-rail button — a cursor mode (mutually exclusive, `on`) or an action. */
function ToolButton({
  on,
  label,
  shortcut,
  onClick,
  children,
}: {
  on?: boolean;
  label: string;
  shortcut?: string;
  onClick: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      className={`fgl-tool${on === true ? ' on' : ''}`}
      title={shortcut === undefined ? label : `${label}  ·  ${shortcut}`}
      aria-label={label}
      aria-pressed={on}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** Left tool rail: cursor modes (top) + momentary frame actions (bottom). */
function ToolRail({
  tool,
  onTool,
  onFit,
  onSavePng,
  onHeader,
  hasHeader,
}: {
  tool: PointerToolMode;
  onTool: (mode: PointerToolMode) => void;
  onFit: () => void;
  onSavePng: () => void;
  onHeader: () => void;
  hasHeader: boolean;
}): JSX.Element {
  return (
    <div className="fgl-toolrail">
      <div className="fgl-toolgroup">
        <ToolButton on={tool === 'pan'} label="Pan" shortcut="Esc" onClick={() => onTool('pan')}>
          <IconPan />
        </ToolButton>
        <ToolButton on={tool === 'ruler'} label="Ruler" shortcut="M" onClick={() => onTool('ruler')}>
          <IconRuler />
        </ToolButton>
      </div>
      <div className="fgl-toolfill" />
      <div className="fgl-toolgroup">
        <ToolButton label="Fit to view" onClick={onFit}>
          <IconFit />
        </ToolButton>
        <ToolButton label="Save PNG" onClick={onSavePng}>
          <IconImage />
        </ToolButton>
        {hasHeader && (
          <ToolButton label="FITS header" onClick={onHeader}>
            <IconHeader />
          </ToolButton>
        )}
      </div>
    </div>
  );
}

/** Tier-0 band rail above the canvas: identity of what's on screen. Single mode
 *  shows selectable chips (number-key shortcuts); RGB mode shows the compact
 *  channel mapping (click → opens the Composite panel). */
function BandRail({
  model,
  onPickBand,
  onMode,
  onOpenComposite,
}: {
  model: BandRailModel;
  onPickBand: (name: string) => void;
  onMode: (mode: 'single' | 'rgb') => void;
  onOpenComposite: () => void;
}): JSX.Element {
  return (
    <div className="fgl-bandrail">
      <span className="fgl-bandrail-cap">bands</span>
      <div className="fgl-bandrail-list">
        {model.mode === 'single'
          ? model.chips.map((c) => (
              <button
                key={c.name}
                type="button"
                className={`fgl-chip${c.active ? ' on' : ''}`}
                aria-pressed={c.active}
                title={c.keyHint > 0 ? `${c.label}  ·  key ${c.keyHint}` : c.label}
                onClick={() => onPickBand(c.name)}
              >
                {c.keyHint > 0 && <span className="fgl-chip-key">{c.keyHint}</span>}
                {c.label}
              </button>
            ))
          : model.channels?.map((ch) => (
              <button
                key={ch.role}
                type="button"
                className="fgl-chan"
                title={`${ch.role.toUpperCase()} = ${ch.label}  ·  edit in Composite`}
                onClick={onOpenComposite}
              >
                <span className="fgl-chan-role" style={{ color: CH_COLOR[ch.role] }}>
                  {ch.role.toUpperCase()}
                </span>
                <span className="fgl-chan-band">{ch.label}</span>
              </button>
            ))}
      </div>
      {model.canComposite && (
        <button
          type="button"
          className={`fgl-rgbtoggle${model.mode === 'rgb' ? ' on' : ''}`}
          aria-pressed={model.mode === 'rgb'}
          onClick={() => onMode(model.mode === 'single' ? 'rgb' : 'single')}
        >
          RGB
        </button>
      )}
    </div>
  );
}

/** A docked inspector panel definition — the registry the shell maps over (so a
 *  future Frames model can add sections without a layout rewrite). */
interface InspectorPanel {
  id: PanelId;
  title: string;
  icon: ReactNode;
  body: ReactNode;
}

/** How the inspector renders: docked (resizable), shelved to its icon rail (wide),
 *  or shelved-with-overlay (narrow viewports). */
type InspectorMode = 'docked' | 'shelved' | 'narrow';

/** The docked right inspector: stacked, independently-collapsible panels; a
 *  shelf-to-icon-rail control; and (on narrow viewports) an overlay drawer. */
function Inspector({
  panels,
  mode,
  narrowOpen,
  collapsed,
  onCollapseInspector,
  onExpandInspector,
  onShelfIcon,
  onToggleCollapse,
  onCloseOverlay,
}: {
  panels: InspectorPanel[];
  mode: InspectorMode;
  narrowOpen: boolean;
  collapsed: Record<string, boolean>;
  onCollapseInspector: () => void;
  onExpandInspector: () => void;
  onShelfIcon: (id: PanelId) => void;
  onToggleCollapse: (id: string) => void;
  onCloseOverlay: () => void;
}): JSX.Element {
  const docked = (overlay: boolean): JSX.Element => (
    <aside className={`fgl-inspector${overlay ? ' overlay' : ''}`}>
      <div className="fgl-inspector-head">
        <span className="fgl-inspector-ttl">Inspector</span>
        <button
          type="button"
          className="fgl-shelf-btn"
          title={overlay ? 'Close' : 'Collapse inspector'}
          aria-label={overlay ? 'Close inspector' : 'Collapse inspector'}
          onClick={overlay ? onCloseOverlay : onCollapseInspector}
        >
          {overlay ? '×' : '⟩'}
        </button>
      </div>
      <div className="fgl-inspector-body">
        {panels.map((p) => {
          const c = collapsed[p.id] === true;
          return (
            <section key={p.id} className={`fgl-panel${c ? ' collapsed' : ''}`}>
              <button type="button" className="fgl-panel-head" aria-expanded={!c} onClick={() => onToggleCollapse(p.id)}>
                <span className="fgl-win-ttl">{p.title}</span>
                <span className="fgl-chev">▾</span>
              </button>
              {!c && <div className="fgl-panel-body">{p.body}</div>}
            </section>
          );
        })}
      </div>
    </aside>
  );

  if (mode === 'docked') return docked(false);

  const shelf = (
    <div className="fgl-inspector shelved">
      <button
        type="button"
        className="fgl-shelf-btn fgl-shelf-top"
        title="Expand inspector"
        aria-label="Expand inspector"
        onClick={onExpandInspector}
      >
        ⟨
      </button>
      {panels.map((p) => (
        <button
          key={p.id}
          type="button"
          className="fgl-shelf-btn"
          title={p.title}
          aria-label={p.title}
          onClick={() => onShelfIcon(p.id)}
        >
          {p.icon}
        </button>
      ))}
    </div>
  );

  if (mode === 'narrow' && narrowOpen) {
    return (
      <>
        {shelf}
        <div className="fgl-inspector-backdrop" onClick={onCloseOverlay} />
        {docked(true)}
      </>
    );
  }
  return shelf;
}

/**
 * Seed the panel's histograms from the producer's pre-computed `band.stats`
 * (converted to the viewer's `Float32Array` shape). Bands without a precomputed
 * histogram are omitted — the viewer scans them live on the first frame as before.
 * Pre-seeding means the panel never shows the "scanning…" placeholder for a built
 * dataset, even if the live scan later fails (large/HTTP/NaN-padded mosaics).
 */
function precomputedHistos(bands: readonly ExplorerBand[]): Record<string, BandHistogram> {
  const out: Record<string, BandHistogram> = {};
  for (const b of bands) {
    if (b.histogram !== undefined) {
      out[b.name] = { counts: Float32Array.from(b.histogram.counts), lo: b.histogram.lo, hi: b.histogram.hi };
    }
  }
  return out;
}

export function FitsExplorer(props: FitsExplorerProps): JSX.Element {
  const handle = useRef<FitsViewerHandle>(null);
  const getViewer = useCallback((): FitsViewerCore | null => handle.current?.getViewer() ?? null, []);

  // "Go to" a sky position (RA/Dec, any common format): recenter, and zoom in to
  // native if currently zoomed out. Returns false on an unparseable/out-of-frame
  // coordinate so the box can flag it. No name resolution — coordinates only.
  const goTo = useCallback((text: string): boolean => {
    const parsed = parseSkyCoord(text);
    const v = handle.current?.getViewer() ?? null;
    const wcs = v?.getWcs() ?? null;
    if (parsed === null || v === null || wcs === null) return false;
    const px = skyToPix(wcs, parsed.ra, parsed.dec);
    if (!Number.isFinite(px.x) || !Number.isFinite(px.y)) return false;
    v.setCenter(px.x, px.y);
    if (v.getCameraState().zoom < 1) v.setZoom(1);
    return true;
  }, []);

  // Accept either the turnkey `config` (a FitsglConfig) or the loose
  // `bands`/`defaultView`/`catalog`/`title` props; `config` wins when present.
  const bands = useMemo<ExplorerBand[]>(
    () => (props.config !== undefined ? explorerBandsFromConfig(props.config) : props.bands ?? []),
    [props.config, props.bands],
  );
  const initialView = useMemo<ExplorerDefaultView | undefined>(
    () => (props.config !== undefined ? defaultViewFromConfig(props.config) : props.defaultView),
    [props.config, props.defaultView],
  );
  const catalogSource = useMemo<MarkerInput[] | { url: string } | undefined>(
    () =>
      props.config?.dataset.catalog !== undefined
        ? { url: props.config.dataset.catalog.url }
        : props.catalog,
    [props.config, props.catalog],
  );
  const title = props.title ?? props.config?.dataset.title;

  // A shared view link (#v=...) read ONCE at mount: it seeds the initial display
  // state below and (its camera) is applied after the first frame. The URL is never
  // written on pan/zoom — only on an explicit "Copy view link" (see the context menu).
  const urlState = useMemo<ShareState | null>(
    () => (typeof window !== 'undefined' ? decodeShareHash(window.location.hash) : null),
    [],
  );

  const [state, setState] = useState<ExplorerState>(() => {
    const base = defaultExplorerState(bands, initialView);
    return urlState !== null ? applyShareToState(base, urlState, bands) : base;
  });
  // Inspector/shell chrome (width + collapse + shelve), persisted globally; the
  // view state above is never persisted (that stays the on-demand share link's job).
  const [layout, setLayout] = useState<LayoutState>(() => parseLayoutState(readLayoutRaw()));
  // Narrow viewports auto-shelve the inspector to its icon rail; opening a panel
  // then floats it as an overlay (`narrowOpen`) instead of crushing the canvas.
  const [narrow, setNarrow] = useState(false);
  const [narrowOpen, setNarrowOpen] = useState(false);
  const [readyTick, setReadyTick] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [headerOpen, setHeaderOpen] = useState(false);
  // The decorative boot overlay: shown until the first frame draws, replayed when
  // the band set reloads (a band change tears down the viewer + refetches pyramids,
  // so the canvas goes blank), and dismissed on a load error so it never sticks.
  const [loading, setLoading] = useState(true);
  // Cursor + zoom readouts update on every pointer-move / zoom frame. They are
  // deliberately NOT React state here: routing them through the explorer's state
  // re-rendered the entire control panel per animation frame during interaction,
  // stealing main-thread time from the render loop. Instead they live in a
  // mutable store and only the `<StatusReadout>` leaf subscribes (same reasoning
  // as the imperative stretch sliders — see the header comment).
  const readoutRef = useRef<ReadoutStore | null>(null);
  if (readoutRef.current === null) readoutRef.current = createReadoutStore();
  const readout = readoutRef.current;
  const [limits, setLimits] = useState<Record<string, { min: number; max: number }>>({});
  const [histos, setHistos] = useState<Record<string, BandHistogram>>(() => precomputedHistos(bands));
  const [markers, setMarkers] = useState<MarkerInput[]>(Array.isArray(catalogSource) ? catalogSource : []);

  useEffect(ensureStyles, []);

  // Re-seed the panel histograms from the producer's pre-computed stats when the band
  // inventory changes (a new config); a live scan still refines on the next frame.
  useEffect(() => {
    setHistos(precomputedHistos(bands));
  }, [bands]);

  // Persist the inspector/shell chrome whenever it changes (fail-safe; private mode
  // or quota just means it doesn't stick). The read happens once in the initializer.
  useEffect(() => {
    try {
      if (typeof window === 'undefined' || window.localStorage == null) return;
      window.localStorage.setItem(LAYOUT_KEY, serializeLayoutState(layout));
    } catch {
      /* no-op: storage unavailable */
    }
  }, [layout]);

  // Track the narrow-viewport breakpoint. jsdom lacks matchMedia, so the guard keeps
  // `narrow` false in tests (desktop-docked path) — no behavioural change there.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(NARROW_QUERY);
    const onChange = (): void => {
      setNarrow(mq.matches);
      if (!mq.matches) setNarrowOpen(false); // leaving narrow: don't keep a stale overlay armed
    };
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Tear down an in-flight gutter drag if the component unmounts mid-resize, so the
  // window listeners + body cursor never leak (the drag's own `up` handler clears it).
  const dragCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => dragCleanupRef.current?.(), []);

  // Keyboard shortcuts: 1–9 select a band (drops RGB→single for fast blink
  // inspection); M toggles the ruler; Esc returns to pan / closes the overlay.
  // Suppressed while typing in a field or when a modifier is held. Re-subscribed on
  // a band-inventory change so the number→band map stays current.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (
        t instanceof HTMLElement &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
      ) {
        return;
      }
      if (e.key >= '1' && e.key <= '9') {
        const b = bands[e.key.charCodeAt(0) - 49]; // '1' → index 0
        if (b !== undefined) {
          e.preventDefault();
          setState((s) => ({ ...s, mode: 'single', band: b.name }));
        }
      } else if (e.key === 'm' || e.key === 'M') {
        e.preventDefault();
        setState((s) => ({ ...s, tool: s.tool === 'ruler' ? 'pan' : 'ruler' }));
      } else if (e.key === 'Escape') {
        setState((s) => (s.tool === 'pan' ? s : { ...s, tool: 'pan' }));
        setNarrowOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [bands]);

  const viewerConfig = useMemo(() => deriveViewerConfig(bands, state), [bands, state]);

  // Replay the boot overlay whenever the band set changes (the only config delta
  // that reloads pyramids + rebuilds the viewer — view/stretch/colormap tweaks are
  // live setters that keep the canvas painted). `onFrame` clears it on the next draw.
  const bandsKey = bandsSignature(viewerConfig);
  useEffect(() => {
    setLoading(true);
  }, [bandsKey]);

  // Fetch a catalog URL into markers (a pre-parsed array is used as-is).
  useEffect(() => {
    const cat = catalogSource;
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
  }, [catalogSource]);

  // Push markers when the overlay is toggled (and re-push after a reload).
  useEffect(() => {
    const h = handle.current;
    if (h === null || readyTick === 0) return;
    if (state.overlay) h.setMarkers(markers);
    else h.clearMarkers();
  }, [state.overlay, markers, readyTick]);

  // The measure tool (ruler): a PointerTool (the Phase 0 seam) that turns a
  // left-drag into a measured line. Endpoints + the derived distance/PA live in the
  // readout store (per-drag high frequency), so only the overlay + status leaf
  // re-render — never the whole control panel. WCS is read live so a band switch
  // mid-session is reflected; without one only the pixel distance is defined.
  const rulerTool = useMemo<PointerTool>(
    () => ({
      cursor: 'crosshair',
      onPointerDown(world) {
        const a = { x: world.x, y: world.y };
        const wcs = getViewer()?.getWcs() ?? null;
        readout.ruler = { a, b: a, dragging: true, ...measureRuler(wcs, a, a) };
        emitReadout(readout);
      },
      onPointerMove(world) {
        const r = readout.ruler;
        if (r === null) return;
        const b = { x: world.x, y: world.y };
        const wcs = getViewer()?.getWcs() ?? null;
        readout.ruler = { a: r.a, b, dragging: true, ...measureRuler(wcs, r.a, b) };
        emitReadout(readout);
      },
      onPointerUp(world) {
        const r = readout.ruler;
        if (r === null) return;
        const b = { x: world.x, y: world.y };
        const wcs = getViewer()?.getWcs() ?? null;
        readout.ruler = { a: r.a, b, dragging: false, ...measureRuler(wcs, r.a, b) };
        emitReadout(readout);
      },
    }),
    [getViewer, readout],
  );

  // Install/clear the tool with the toggle (gated on a ready viewer, like markers).
  // Turning it off also clears any drawn line so re-enabling starts fresh.
  useEffect(() => {
    const h = handle.current;
    if (h === null || readyTick === 0) return;
    const rulerOn = state.tool === 'ruler';
    h.setTool(rulerOn ? rulerTool : null);
    if (!rulerOn && readout.ruler !== null) {
      readout.ruler = null;
      emitReadout(readout);
    }
  }, [state.tool, rulerTool, readyTick, readout]);

  // Apply a shared link's camera once, after the first frame (the construction-time
  // fitToImage has run by then, so this overrides it to the shared sky position).
  const urlCamAppliedRef = useRef(false);
  useEffect(() => {
    if (urlCamAppliedRef.current || readyTick === 0) return;
    const cam = urlState?.c;
    if (cam === undefined) {
      urlCamAppliedRef.current = true;
      return;
    }
    const v = handle.current?.getViewer() ?? null;
    const wcs = v?.getWcs() ?? null;
    if (v === null || wcs === null) return;
    const px = skyToPix(wcs, cam[0], cam[1]);
    if (Number.isFinite(px.x) && Number.isFinite(px.y)) {
      v.setCenter(px.x, px.y);
      if (cam[2] > 0) v.setZoom(cam[2]);
    }
    urlCamAppliedRef.current = true;
  }, [readyTick, urlState]);

  // Stretch MODE is imperative: a flip must not re-auto-stretch the manual limits.
  // Trilogy needs precomputed per-band stats; when an active band lacks them, drive
  // the viewer with a plain `log` curve instead (the UI still shows `trilogy` + the
  // "no precomputed stats" warning, and seed() sets sane limits). Otherwise the
  // mode-3 RGB luminance path would render with its un-solved default (Lsat = 1).
  useEffect(() => {
    const triMissing =
      state.stretch === 'trilogy' &&
      activeBandNames(state).some((n) => bands.find((b) => b.name === n)?.trilogy === undefined);
    getViewer()?.setStretchMode(triMissing ? 'log' : state.stretch);
  }, [state.stretch, state.mode, state.band, state.rgb, state.weightBands, bands, readyTick, getViewer]);

  // Seed the limits sliders + histograms from the data in view, after the source
  // changes (or a reload). Deferred to the next drawn frame (autoStretch /
  // visibleHistogram need a frame's level+bounds), via `needSeedRef` + onFrame.
  // Keyed on the render-source signature (band set + mode, weights excluded) so a
  // band-set change re-seeds but a pure weight tweak (pushed imperatively) does not.
  const viewSig = viewSignature(viewerConfig.view);
  const needSeedRef = useRef(true);
  useEffect(() => {
    needSeedRef.current = true;
  }, [viewSig, readyTick]);

  // Faithful, color-preserving trilogy from the producer's precomputed global
  // stats — no tile rescan, so it is stable and viewport-independent. Returns
  // false (caller falls back to the percentile auto-stretch) when the viewer mode
  // is mid-switch or a band lacks precomputed stats. Reflects the solved black/
  // white points (x0/x2) back into the sliders.
  const applyTrilogyFromStats = useCallback(
    (v: FitsViewerCore): boolean => {
      // The viewer mode for an RGB trilogy view is the faithful weighted composite
      // ('multiband'); single-band trilogy is 'single'. Bail until it has synced.
      const expectedMode = state.mode === 'single' ? 'single' : 'multiband';
      if (v.sourceMode !== expectedMode) return false;
      const names = activeBandNames(state);
      const triStats = names.map((n) => bands.find((b) => b.name === n)?.trilogy);
      if (triStats.some((s) => s === undefined)) return false;
      // Each band stretched by its own levels (faithful trilogy): one stats per band.
      const levels = v.applyTrilogy(
        state.mode === 'single'
          ? (triStats[0] as TrilogyStats)
          : (triStats as TrilogyStats[]),
        state.trilogyParams,
      );
      setLimits((prev) => {
        const next = { ...prev };
        names.forEach((n, i) => {
          next[n] = { min: levels[i].x0, max: levels[i].x2 };
        });
        return next;
      });
      return true;
    },
    [bands, state.mode, state.band, state.rgb, state.weightBands, state.trilogyParams],
  );

  // Re-apply trilogy live when a knob moves (the viewer mode is already settled,
  // so no rescan and no source-switch race — purely the precomputed-stats path).
  useEffect(() => {
    if (state.stretch !== 'trilogy') return;
    const v = getViewer();
    if (v !== null) applyTrilogyFromStats(v);
  }, [state.stretch, state.trilogyParams, readyTick, getViewer, applyTrilogyFromStats]);

  // Push per-band weight edits imperatively (like the limit sliders): a weight
  // tweak repaints without rebuilding the source. A change to the *set* of bands
  // goes through `setSource` (the multiband view carries the new weights), so the
  // count can momentarily mismatch mid-rebuild — guarded by the mode + a try/catch.
  useEffect(() => {
    if (!isTrilogyComposite(state)) return;
    const v = getViewer();
    if (v === null || v.sourceMode !== 'multiband') return;
    try {
      v.setBandWeights(trilogyComposite(state).map((e) => e.weight));
    } catch {
      // Band set mid-rebuild; the pending setSource carries the right weights.
    }
  }, [state, readyTick, getViewer]);

  // Auto-stretch the data in view to a percentile window (fractions 0–1; omit for
  // the viewer default 1–99%), then read the applied range(s) + visible histogram
  // back into the panel. Shared by `seed()` and the one-click Limits presets.
  const applyAutoStretch = useCallback(
    async (pLo?: number, pHi?: number): Promise<void> => {
      const v = getViewer();
      if (v === null) return;
      const [auto, hist] = await Promise.all([v.autoStretch(pLo, pHi), v.visibleHistogram()]);
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
    },
    [getViewer, state.band, state.rgb.r, state.rgb.g, state.rgb.b],
  );

  const seed = useCallback(async (): Promise<void> => {
    const v = getViewer();
    if (v === null) return;
    // Trilogy drives its levels from precomputed global stats (no per-channel
    // sliders, hence no histogram readback). Fall through to the percentile
    // auto-stretch only when trilogy could not apply (mode mid-switch / no stats).
    const trilogyApplied = state.stretch === 'trilogy' && applyTrilogyFromStats(v);
    if (!trilogyApplied) await applyAutoStretch();
  }, [getViewer, state.stretch, applyTrilogyFromStats, applyAutoStretch]);

  const onFrame = (info: ViewerFrameInfo): void => {
    // Same change-guard the old setState had: a pan (level/zoom/northUp all
    // unchanged) doesn't touch the readout at all.
    const prev = readout.frame;
    if (prev === null || prev.level !== info.level || prev.zoom !== info.zoom || prev.northUp !== info.northUp) {
      readout.frame = info;
      emitReadout(readout);
    }
    if (needSeedRef.current) {
      needSeedRef.current = false;
      void seed();
    }
    // First real pixels are on screen — hand off from the placeholder. Guarded so a
    // steady pan/zoom stream doesn't churn state (setState bails on an equal value).
    if (loading) setLoading(false);
  };

  const onCursor = useCallback(
    (info: CursorInfo | null): void => {
      readout.cursor = info;
      emitReadout(readout);
    },
    [readout],
  );

  const setLimit = (bandName: string, min: number, max: number, role?: Role): void => {
    setLimits((prev) => ({ ...prev, [bandName]: { min, max } }));
    const v = getViewer();
    if (v === null) return;
    if (role !== undefined) v.setChannelStretch(role, min, max);
    else v.setStretch(min, max);
  };

  // Apply the producer's precomputed whole-image zscale cuts (DS9/IRAF) to the
  // active band(s) — instant, stable, and not viewport-dependent (unlike the live
  // percentile auto-stretch). Per RGB channel in RGB mode.
  const zscaleOf = (name: string): readonly [number, number] | undefined =>
    bands.find((b) => b.name === name)?.zscale;
  const applyZscale = (): void => {
    if (state.mode === 'single') {
      const z = zscaleOf(state.band);
      if (z !== undefined) setLimit(state.band, z[0], z[1]);
    } else {
      for (const role of ['r', 'g', 'b'] as const) {
        const z = zscaleOf(state.rgb[role]);
        if (z !== undefined) setLimit(state.rgb[role], z[0], z[1], role);
      }
    }
  };
  const hasZscale = hasZscalePreset(bands, state);

  // Build a shareable link to the CURRENT view on demand (the right-click menu),
  // sky-anchoring the camera so the link survives a rebuild. The URL is never
  // mutated by panning/zooming — only assembled here when the user asks.
  const makeShareUrl = useCallback((): string => {
    const r = (n: number, d: number): number => {
      const f = 10 ** d;
      return Math.round(n * f) / f;
    };
    const s: ShareState = {
      m: state.mode,
      b: state.band,
      rgb: [state.rgb.r, state.rgb.g, state.rgb.b],
      s: state.stretch,
      cm: state.colormap,
      n: state.northUp ? 1 : 0,
      g: state.graticule ? 1 : 0,
    };
    const v = handle.current?.getViewer() ?? null;
    const wcs = v?.getWcs() ?? null;
    const cam = v?.getCameraState() ?? null;
    if (v !== null && wcs !== null && cam !== null) {
      const sky = pixToSky(wcs, cam.centerX, cam.centerY);
      if (Number.isFinite(sky.ra) && Number.isFinite(sky.dec)) {
        s.c = [r(sky.ra, 6), r(sky.dec, 6), r(cam.zoom, 4)];
      }
    }
    return buildShareUrl(window.location.href, s);
  }, [state]);

  const activeBands = activeBandNames(state);
  const activeLabels = activeBands.map((n) => bands.find((b) => b.name === n)?.label ?? n);

  // The active band's header.json sidecar lives next to its manifest.json (same
  // dir): derive its URL by swapping the last path segment.
  const headerBand = bands.find((b) => b.name === activeBands[0]);
  const headerUrl = headerBand?.tiles[0]?.replace(/[^/]*$/, 'header.json') ?? null;
  const headerLabel = headerBand?.label ?? headerBand?.name ?? '';

  const containerStyle =
    props.style === undefined ? ROOT_STYLE : { ...ROOT_STYLE, ...props.style };

  // Right-click over the canvas opens the share menu. The inspector + rails are
  // outside the stage now, so this only ever fires over real image pixels.
  const onStageContextMenu = (e: ReactMouseEvent): void => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY });
  };

  // ---- band rail + inspector handlers ---------------------------------------
  const rail = bandRailModel(bands, state);
  const pickBand = (name: string): void => setState((s) => ({ ...s, mode: 'single', band: name }));
  const toggleCollapse = (id: string): void =>
    setLayout((l) => ({ ...l, collapsed: { ...l.collapsed, [id]: !(l.collapsed[id] === true) } }));
  // Reveal a panel: un-shelve + un-collapse it (and pop the overlay on narrow).
  const openPanel = (id: PanelId): void => {
    setLayout((l) => ({ ...l, shelved: false, collapsed: { ...l.collapsed, [id]: false } }));
    if (narrow) setNarrowOpen(true);
  };
  const setMode = (mode: 'single' | 'rgb'): void => {
    setState((s) => ({ ...s, mode }));
    if (mode === 'rgb') openPanel('composite'); // entering RGB reveals its setup
  };
  const collapseInspector = (): void => {
    if (narrow) setNarrowOpen(false);
    else setLayout((l) => ({ ...l, shelved: true }));
  };
  const expandInspector = (): void => {
    if (narrow) setNarrowOpen(true);
    else setLayout((l) => ({ ...l, shelved: false }));
  };
  // Drag the gutter to resize the inspector (clamped + persisted). Dragging left
  // (decreasing clientX) widens it, since the inspector sits to the gutter's right.
  const onGutterDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = layout.width;
    const move = (ev: PointerEvent): void =>
      setLayout((l) => {
        const next = clampInspectorWidth(startW + (startX - ev.clientX));
        return l.width === next ? l : { ...l, width: next };
      });
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.cursor = '';
      dragCleanupRef.current = null;
    };
    dragCleanupRef.current = up;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    document.body.style.cursor = 'col-resize';
  };
  // Keyboard resize: ArrowLeft widens (gutter sits left of the inspector), ArrowRight
  // narrows; Shift = coarse. Mirrors the drag direction + clamp.
  const onGutterKey = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const step = e.shiftKey ? 24 : 8;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      setLayout((l) => ({ ...l, width: clampInspectorWidth(l.width + step) }));
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      setLayout((l) => ({ ...l, width: clampInspectorWidth(l.width - step) }));
    }
  };

  const savePng = (): void => {
    const url = handle.current?.exportPNG();
    if (url === null || url === undefined) return;
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(title ?? 'fitsgl').replace(/\s+/g, '_')}.png`;
    a.click();
  };

  // ---- inspector panel registry (the shell maps over this) ------------------
  const triMissing = activeBands.some((n) => bands.find((b) => b.name === n)?.trilogy === undefined);
  const fineCollapsed = layout.collapsed['display.fine'] === true;

  const displayBody = (
    <>
      <div className="fgl-sub">
        <span className="fgl-cap">Scale</span>
        <ScaleButtons value={state.stretch} onChange={(m) => setState((s) => ({ ...s, stretch: m }))} />
      </div>

      <div className="fgl-sub">
        <span className="fgl-cap">Limits</span>
        {state.stretch === 'trilogy' ? (
          <div className="fgl-note">Levels set from precomputed trilogy stats.</div>
        ) : (
          <div className="fgl-presets">
            <button type="button" className="fgl-preset" onClick={() => void applyAutoStretch()}>
              auto
            </button>
            {hasZscale && (
              <button type="button" className="fgl-preset" title="Whole-image DS9/IRAF zscale cuts" onClick={applyZscale}>
                zscale
              </button>
            )}
            <button type="button" className="fgl-preset" title="Full data min–max in view" onClick={() => void applyAutoStretch(0, 1)}>
              minmax
            </button>
            <button type="button" className="fgl-preset" title="0.25–99.75% in view" onClick={() => void applyAutoStretch(0.0025, 0.9975)}>
              99.5%
            </button>
          </div>
        )}
      </div>

      {state.mode === 'single' && (
        <div className="fgl-sub">
          <span className="fgl-cap">Colormap</span>
          <ColormapSwatches value={state.colormap} onChange={(name) => setState((s) => ({ ...s, colormap: name }))} />
          {state.stretch !== 'trilogy' &&
            (() => {
              const lim =
                limits[state.band] ??
                (histos[state.band] !== undefined
                  ? { min: histos[state.band]!.lo, max: histos[state.band]!.hi }
                  : undefined);
              return lim !== undefined ? (
                <Colorbar min={lim.min} max={lim.max} mode={state.stretch} colormap={state.colormap} />
              ) : null;
            })()}
        </div>
      )}

      <div className={`fgl-disclose${fineCollapsed ? ' collapsed' : ''}`}>
        <button
          type="button"
          className="fgl-disclose-head"
          aria-expanded={!fineCollapsed}
          onClick={() => toggleCollapse('display.fine')}
        >
          <span className="fgl-cap">Fine adjustment</span>
          <span className="fgl-chev">▾</span>
        </button>
        {!fineCollapsed && (
          <div className="fgl-disclose-body">
            {state.stretch === 'trilogy' ? (
              <TrilogyControls
                params={state.trilogyParams}
                missing={triMissing}
                onChange={(patch) => setState((s) => ({ ...s, trilogyParams: { ...s.trilogyParams, ...patch } }))}
              />
            ) : state.mode === 'single' ? (
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
          </div>
        )}
      </div>
    </>
  );

  const compositeBody =
    state.mode === 'single' ? (
      <div className="fgl-note">Switch to RGB (band rail) to composite co-gridded bands into colour.</div>
    ) : state.stretch === 'trilogy' ? (
      <TrilogyWeightMatrix
        bands={bands}
        state={state}
        onApply={(entries) =>
          setState((s) => {
            const weights = { ...s.weights };
            for (const e of entries) weights[e.band] = e.weight;
            return { ...s, weights, weightBands: entries.map((e) => e.band) };
          })
        }
        onRainbow={() =>
          setState((s) => {
            const patch = rainbowAction(bands, rgbActiveGroup(bands, s.rgb));
            return { ...s, weights: { ...s.weights, ...patch.weights }, weightBands: patch.weightBands };
          })
        }
      />
    ) : (
      <>
        <RgbGrid
          bands={bands}
          rgb={state.rgb}
          onPick={(role, band) => setState((s) => ({ ...s, rgb: { ...s.rgb, [role]: band } }))}
        />
        <div className="fgl-note">RGB requires co-gridded bands — cross-grid filters grey out.</div>
      </>
    );

  const viewBody = (
    <>
      <ToggleSwitch
        label="North up"
        on={state.northUp}
        onToggle={() => setState((s) => ({ ...s, northUp: !s.northUp }))}
      />
      <ToggleSwitch
        label="Coordinate grid"
        on={state.graticule}
        onToggle={() => setState((s) => ({ ...s, graticule: !s.graticule }))}
      />
      <ToggleSwitch
        label="Catalog overlay"
        on={state.overlay}
        disabled={markers.length === 0}
        onToggle={() => setState((s) => ({ ...s, overlay: !s.overlay }))}
      />
      <div className="fgl-sub">
        <span className="fgl-cap">Go to</span>
        <GotoBox onGo={goTo} />
      </div>
    </>
  );

  const panels: InspectorPanel[] = [
    { id: 'display', title: 'Display', icon: <IconDisplay />, body: displayBody },
    { id: 'composite', title: 'Composite', icon: <IconComposite />, body: compositeBody },
    { id: 'view', title: 'View', icon: <IconView />, body: viewBody },
  ];

  const inspectorMode: InspectorMode = narrow ? 'narrow' : layout.shelved ? 'shelved' : 'docked';
  // Docked: 4 tracks — the resize gutter <div> is the 3rd in-flow child. Shelved/narrow:
  // the gutter isn't rendered, so use a 3-track template; otherwise the shelf rail (the
  // 3rd in-flow child) auto-places into the gutter track and a 4th empty track strands it.
  const shellStyle: CSSProperties = {
    gridTemplateColumns:
      inspectorMode === 'docked'
        ? `auto minmax(0,1fr) 6px ${layout.width}px`
        : 'auto minmax(0,1fr) 38px',
  };

  return (
    <div className={`fgl-explorer${props.className === undefined ? '' : ` ${props.className}`}`} style={containerStyle}>
      {menu !== null && (
        <ShareMenu x={menu.x} y={menu.y} onCopy={makeShareUrl} onClose={() => setMenu(null)} />
      )}
      {headerOpen && headerUrl !== null && (
        <HeaderPanel url={headerUrl} title={headerLabel} onClose={() => setHeaderOpen(false)} />
      )}
      <div className="fgl-shell" style={shellStyle}>
        <ToolRail
          tool={state.tool}
          onTool={(t) => setState((s) => ({ ...s, tool: t }))}
          onFit={() => handle.current?.fitToImage()}
          onSavePng={savePng}
          onHeader={() => setHeaderOpen(true)}
          hasHeader={headerUrl !== null}
        />
        <div className="fgl-main">
          {rail.show && (
            <BandRail
              model={rail}
              onPickBand={pickBand}
              onMode={setMode}
              onOpenComposite={() => openPanel('composite')}
            />
          )}
          <div className="fgl-stage" onContextMenu={onStageContextMenu}>
            <FitsViewer
              config={viewerConfig}
              ref={handle}
              tileOptions={props.tileOptions}
              textureBudget={props.textureBudget}
              hiDpiLevels={props.hiDpiLevels}
              markerTooltip={props.markerTooltip}
              onMarkerClick={props.onMarkerClick}
              onCursor={onCursor}
              onFrame={onFrame}
              onReady={() => setReadyTick((t) => t + 1)}
              onError={(e) => {
                setLoading(false);
                props.onError?.(e);
              }}
            >
              {state.graticule && <Graticule getViewer={getViewer} store={readout} />}
              {state.tool === 'ruler' && <RulerOverlay getViewer={getViewer} store={readout} />}
              <FitsLoadingField active={loading} />
            </FitsViewer>
          </div>
        </div>
        {inspectorMode === 'docked' && (
          <div
            className="fgl-gutter"
            onPointerDown={onGutterDown}
            onKeyDown={onGutterKey}
            tabIndex={0}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize inspector"
            aria-valuemin={INSPECTOR_MIN_WIDTH}
            aria-valuemax={INSPECTOR_MAX_WIDTH}
            aria-valuenow={layout.width}
          />
        )}
        <Inspector
          panels={panels}
          mode={inspectorMode}
          narrowOpen={narrowOpen}
          collapsed={layout.collapsed}
          onCollapseInspector={collapseInspector}
          onExpandInspector={expandInspector}
          onShelfIcon={openPanel}
          onToggleCollapse={toggleCollapse}
          onCloseOverlay={() => setNarrowOpen(false)}
        />
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
        <span className="fgl-item">
          <i>tool</i>
          <b>{state.tool}</b>
        </span>
        <span className="fgl-spacer" />
        <StatusReadout store={readout} />
      </div>
    </div>
  );
}

/**
 * Mutable holder for the per-frame status readouts (cursor sky position + zoom).
 * The explorer's `onCursor`/`onFrame` callbacks write into it and bump `version`;
 * only `<StatusReadout>` subscribes, so a pointer move or zoom frame re-renders
 * that one leaf instead of reconciling the whole control panel at frame rate.
 */
interface ReadoutStore {
  cursor: CursorInfo | null;
  frame: ViewerFrameInfo | null;
  /** Live ruler measurement (measure tool); null when idle/inactive. */
  ruler: RulerGeometry | null;
  version: number;
  listeners: Set<() => void>;
}

function createReadoutStore(): ReadoutStore {
  return { cursor: null, frame: null, ruler: null, version: 0, listeners: new Set() };
}

function emitReadout(store: ReadoutStore): void {
  store.version++;
  for (const l of store.listeners) l();
}

/** "Go to coordinates" box: parses RA/Dec on Enter/Go and recenters via `onGo`,
 *  flashing an error border when the input doesn't parse or is off the image. */
function GotoBox({ onGo }: { onGo: (text: string) => boolean }): JSX.Element {
  const [text, setText] = useState('');
  const [err, setErr] = useState(false);
  const submit = (): void => {
    if (text.trim() === '') return;
    setErr(!onGo(text));
  };
  return (
    <div className="fgl-goto">
      <input
        className={`fgl-goto-in${err ? ' err' : ''}`}
        type="text"
        value={text}
        placeholder="RA Dec — e.g. 10:00:00 +02:12:00"
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => {
          setText(e.target.value);
          setErr(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
        }}
      />
      <button type="button" className="fgl-goto-btn" onClick={submit}>
        Go
      </button>
    </div>
  );
}

/** The right-click menu: a single "Copy view link" action that builds a shareable
 *  URL on demand (the URL is never live-updated). Closes on any outside interaction. */
function ShareMenu({
  x,
  y,
  onCopy,
  onClose,
}: {
  x: number;
  y: number;
  onCopy: () => string;
  onClose: () => void;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    window.addEventListener('mousedown', onClose);
    window.addEventListener('keydown', onClose);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('mousedown', onClose);
      window.removeEventListener('keydown', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);
  const copy = (): void => {
    const url = onCopy();
    const done = (): void => {
      setCopied(true);
      window.setTimeout(onClose, 900);
    };
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText !== undefined) {
      navigator.clipboard.writeText(url).then(done, done);
    } else {
      done();
    }
  };
  return (
    // Stop mousedown from reaching the window closer so the click lands on the item.
    <div className="fgl-menu" style={{ left: x, top: y }} onMouseDown={(e) => e.stopPropagation()}>
      <button type="button" className="fgl-menu-item" onClick={copy}>
        {copied ? 'Link copied ✓' : 'Copy view link'}
      </button>
    </div>
  );
}

interface HeaderCard {
  keyword: string;
  value: string | number | boolean | null;
  comment: string;
}
interface HeaderDoc {
  version: number;
  source_file: string;
  cards: HeaderCard[];
}

/** Render a FITS card value the DS9 way: booleans as T/F, undefined as blank. */
function fmtHeaderValue(v: string | number | boolean | null): string {
  if (v === null) return '';
  if (typeof v === 'boolean') return v ? 'T' : 'F';
  return String(v);
}

/** A modal FITS-header viewer: fetches the band's header.json sidecar on demand and
 *  lists the full ordered card set. Closes on backdrop click or Escape. */
function HeaderPanel({
  url,
  title,
  onClose,
}: {
  url: string;
  title: string;
  onClose: () => void;
}): JSX.Element {
  const [doc, setDoc] = useState<HeaderDoc | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let live = true;
    setDoc(null);
    setErr(false);
    fetch(url)
      .then((r) => (r.ok ? (r.json() as Promise<HeaderDoc>) : Promise.reject(new Error(String(r.status)))))
      .then((d) => {
        if (live) setDoc(d);
      })
      .catch(() => {
        if (live) setErr(true);
      });
    return () => {
      live = false;
    };
  }, [url]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const commentLike = (k: string): boolean => k === 'COMMENT' || k === 'HISTORY' || k === '';
  return (
    <div className="fgl-modal" onMouseDown={onClose}>
      <div className="fgl-hdr" onMouseDown={(e) => e.stopPropagation()}>
        <div className="fgl-hdr-head">
          <span>FITS header · {title}</span>
          <button type="button" className="fgl-hdr-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="fgl-hdr-body">
          {err ? (
            <div className="fgl-hdr-msg">No header available for this band.</div>
          ) : doc === null ? (
            <div className="fgl-hdr-msg">Loading…</div>
          ) : (
            doc.cards.map((c, i) =>
              commentLike(c.keyword) ? (
                <div key={i} className="fgl-hdr-card comment">
                  <span className="fgl-hdr-k">{c.keyword}</span>
                  <span className="fgl-hdr-v">{c.comment || fmtHeaderValue(c.value)}</span>
                </div>
              ) : (
                <div key={i} className="fgl-hdr-card">
                  <span className="fgl-hdr-k">{c.keyword}</span>
                  <span className="fgl-hdr-eq">=</span>
                  <span className="fgl-hdr-v">{fmtHeaderValue(c.value)}</span>
                  {c.comment !== '' && <span className="fgl-hdr-c">/ {c.comment}</span>}
                </div>
              ),
            )
          )}
        </div>
      </div>
    </div>
  );
}

/** A Canvas2D RA/Dec graticule stacked over the GL canvas; redraws each frame by
 *  subscribing to the readout store (the per-frame leaf pattern of StatusReadout). */
function Graticule({
  getViewer,
  store,
}: {
  getViewer: () => FitsViewerCore | null;
  store: ReadoutStore;
}): JSX.Element {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useSyncExternalStore(
    (cb) => {
      store.listeners.add(cb);
      return (): void => {
        store.listeners.delete(cb);
      };
    },
    () => store.version,
    () => 0,
  );
  useEffect(() => {
    drawGraticule(ref.current, getViewer());
  });
  return <canvas ref={ref} className="fgl-grat" aria-hidden="true" />;
}

/** A Canvas2D ruler line + measurement label stacked over the GL canvas; redraws by
 *  subscribing to the readout store (which the measure tool bumps on every drag move,
 *  and which the per-frame onFrame/onCursor traffic bumps so it stays glued on zoom). */
function RulerOverlay({
  getViewer,
  store,
}: {
  getViewer: () => FitsViewerCore | null;
  store: ReadoutStore;
}): JSX.Element {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useSyncExternalStore(
    (cb) => {
      store.listeners.add(cb);
      return (): void => {
        store.listeners.delete(cb);
      };
    },
    () => store.version,
    () => 0,
  );
  useEffect(() => {
    drawRuler(ref.current, getViewer(), store.ruler);
  });
  return <canvas ref={ref} className="fgl-ruler" aria-hidden="true" />;
}

/** Format a pixel value for the status bar: '—' for no-data / not-resident, else
 *  5 significant figures with trailing zeros trimmed. */
function formatValue(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—';
  return Number(v.toPrecision(5)).toString();
}

/** The value/pixel/α/δ/zoom status-bar cells — the only subtree that updates per frame. */
function StatusReadout({ store }: { store: ReadoutStore }): JSX.Element {
  useSyncExternalStore(
    (onChange) => {
      store.listeners.add(onChange);
      return (): void => {
        store.listeners.delete(onChange);
      };
    },
    () => store.version,
    () => 0,
  );
  const { cursor, frame, ruler } = store;
  const inside = cursor !== null && cursor.insideImage;
  const pixStr =
    cursor !== null && cursor.insideImage
      ? `${Math.floor(cursor.worldX)}, ${Math.floor(cursor.worldY)}`
      : '—';
  const valStr =
    cursor !== null && cursor.insideImage ? cursor.values.map(formatValue).join(' ') : '—';
  // The value is sampled from the displayed LOD; flag it when that isn't native (1:1).
  const valTitle =
    inside && cursor !== null && !cursor.native ? `binned · pyramid level ${cursor.level}` : undefined;
  return (
    <>
      <span className="fgl-item coord" title={valTitle}>
        <i>val{inside && cursor !== null && !cursor.native ? '*' : ''}</i>
        <b>{valStr}</b>
      </span>
      <span className="fgl-item coord">
        <i>x,y</i>
        <b>{pixStr}</b>
      </span>
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
      {ruler !== null && (
        <>
          <span className="fgl-item coord" title={`${ruler.pixelDist.toFixed(2)} px`}>
            <i>dist</i>
            <b>{ruler.sepDeg !== null ? formatSeparation(ruler.sepDeg) : `${ruler.pixelDist.toFixed(1)} px`}</b>
          </span>
          {ruler.paDeg !== null && (
            <span className="fgl-item coord">
              <i>PA</i>
              <b>{`${ruler.paDeg.toFixed(1)}°`}</b>
            </span>
          )}
        </>
      )}
    </>
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
/* ---- tokens (unchanged visual language) -------------------------------- */
.fgl-explorer{--win:#0e1320;--inset:#080b12;--line:rgba(150,170,210,.11);--line2:rgba(150,170,210,.2);
  --text:#cdd5e3;--dim:#828ca3;--faint:#566073;--gold:#e0ad4d;--gold-d:#7d6630;
  --mono:'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
  color:var(--text);font-family:var(--mono);font-size:12.5px;}
.fgl-explorer *{box-sizing:border-box;}
.fgl-chev{color:var(--gold);font-size:10px;transition:transform .2s;}
.fgl-win-ttl{font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--dim);}
.fgl-cap{display:block;font-size:9.5px;letter-spacing:.18em;text-transform:uppercase;color:var(--faint);margin-bottom:9px;}

/* ---- app shell: tool-rail | main(band-rail + canvas) | gutter | inspector */
.fgl-shell{flex:1;min-height:0;display:grid;position:relative;}
.fgl-main{display:flex;flex-direction:column;min-width:0;min-height:0;position:relative;}
.fgl-stage{flex:1;position:relative;min-height:0;min-width:0;}

/* ---- left tool rail (cursor modes + frame actions) --------------------- */
.fgl-toolrail{display:flex;flex-direction:column;align-items:center;gap:4px;padding:8px 6px;
  background:#0b0f18;border-right:1px solid var(--line2);}
.fgl-toolgroup{display:flex;flex-direction:column;gap:4px;}
.fgl-toolrail .fgl-toolgroup:last-child{border-top:1px solid var(--line);padding-top:8px;}
.fgl-toolfill{flex:1;}
.fgl-tool{width:30px;height:30px;display:flex;align-items:center;justify-content:center;background:transparent;
  border:1px solid transparent;border-radius:5px;color:var(--dim);cursor:pointer;padding:0;}
.fgl-tool:hover{color:var(--text);background:var(--inset);}
.fgl-tool.on{color:var(--gold);border-color:var(--gold-d);background:rgba(224,173,77,.1);}

/* ---- top band rail (Tier-0 identity) ---------------------------------- */
.fgl-bandrail{flex:none;display:flex;align-items:center;gap:9px;padding:7px 11px;
  background:#0b0f18;border-bottom:1px solid var(--line2);}
.fgl-bandrail-cap{flex:none;font-size:9.5px;letter-spacing:.18em;text-transform:uppercase;color:var(--faint);}
.fgl-bandrail-list{flex:1;min-width:0;display:flex;align-items:center;gap:5px;flex-wrap:nowrap;overflow-x:auto;}
.fgl-chip{flex:none;display:inline-flex;align-items:center;gap:5px;background:var(--inset);border:1px solid var(--line2);
  border-radius:4px;color:var(--dim);font-family:var(--mono);font-size:11px;letter-spacing:.04em;padding:5px 9px;cursor:pointer;white-space:nowrap;}
.fgl-chip:hover{color:var(--text);border-color:var(--dim);}
.fgl-chip.on{background:var(--gold);border-color:var(--gold);color:#161003;font-weight:500;}
.fgl-chip-key{font-size:8.5px;opacity:.55;font-variant-numeric:tabular-nums;}
.fgl-chan{flex:none;display:inline-flex;align-items:center;gap:6px;background:var(--inset);border:1px solid var(--line2);
  border-radius:4px;padding:4px 9px;cursor:pointer;white-space:nowrap;}
.fgl-chan:hover{border-color:var(--dim);}
.fgl-chan-role{font-size:10px;font-weight:700;letter-spacing:.06em;}
.fgl-chan-band{font-size:11px;color:var(--text);}
.fgl-rgbtoggle{flex:none;margin-left:auto;background:transparent;border:1px solid var(--line2);color:var(--dim);
  font-family:var(--mono);font-size:10px;letter-spacing:.12em;text-transform:uppercase;padding:5px 12px;border-radius:4px;cursor:pointer;}
.fgl-rgbtoggle:hover{border-color:var(--gold-d);color:var(--gold);}
.fgl-rgbtoggle.on{background:var(--gold);border-color:var(--gold);color:#161003;font-weight:600;}

/* ---- resize gutter ---------------------------------------------------- */
.fgl-gutter{cursor:col-resize;position:relative;background:transparent;outline:none;}
.fgl-gutter::after{content:"";position:absolute;top:0;bottom:0;left:50%;width:1px;background:var(--line2);transform:translateX(-50%);}
.fgl-gutter:hover::after{background:var(--gold-d);width:2px;}
.fgl-gutter:focus-visible::after{background:var(--gold);width:2px;}

/* ---- docked inspector + panels + shelf -------------------------------- */
.fgl-inspector{display:flex;flex-direction:column;min-height:0;background:var(--win);border-left:1px solid var(--line2);overflow:hidden;}
.fgl-inspector.shelved{align-items:center;gap:4px;padding:8px 0;background:#0b0f18;}
.fgl-inspector.overlay{position:absolute;top:0;right:0;bottom:0;width:min(86vw,340px);z-index:30;box-shadow:-12px 0 40px rgba(0,0,0,.5);}
.fgl-inspector-backdrop{position:absolute;inset:0;z-index:25;background:rgba(2,4,8,.4);}
.fgl-inspector-head{flex:none;display:flex;align-items:center;justify-content:space-between;padding:9px 12px;border-bottom:1px solid var(--line2);}
.fgl-inspector-ttl{font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--dim);}
.fgl-inspector-body{flex:1;min-height:0;overflow-y:auto;}
.fgl-shelf-btn{display:flex;align-items:center;justify-content:center;width:28px;height:28px;background:transparent;
  border:1px solid transparent;border-radius:5px;color:var(--dim);cursor:pointer;padding:0;font-size:13px;}
.fgl-shelf-btn:hover{color:var(--gold);background:var(--inset);}
.fgl-shelf-top{margin-bottom:8px;}
.fgl-panel{border-bottom:1px solid var(--line);}
.fgl-panel-head{display:flex;align-items:center;justify-content:space-between;width:100%;padding:10px 12px;cursor:pointer;
  user-select:none;background:transparent;border:0;font-family:var(--mono);color:inherit;text-align:left;}
.fgl-panel.collapsed .fgl-chev{transform:rotate(-90deg);}
.fgl-panel-body{padding:0 12px 14px;}
.fgl-panel-body>.fgl-tg{padding:7px 0;}
.fgl-panel-body>.fgl-note:first-child{margin-top:0;}
.fgl-sub{margin-top:14px;}
.fgl-sub:first-child{margin-top:11px;}
.fgl-presets{display:flex;flex-wrap:wrap;gap:5px;}
.fgl-preset{flex:1;min-width:54px;background:transparent;border:1px solid var(--line2);color:var(--dim);font-family:var(--mono);
  font-size:10px;letter-spacing:.08em;text-transform:uppercase;padding:7px 6px;border-radius:4px;cursor:pointer;}
.fgl-preset:hover{border-color:var(--gold-d);color:var(--gold);}
.fgl-swatches{display:grid;grid-template-columns:repeat(3,1fr);gap:5px;}
.fgl-swatch{display:flex;flex-direction:column;gap:3px;background:transparent;border:1px solid var(--line2);border-radius:4px;padding:4px;cursor:pointer;}
.fgl-swatch:hover{border-color:var(--dim);}
.fgl-swatch.on{border-color:var(--gold);}
.fgl-swatch-bar{height:14px;border-radius:2px;border:1px solid rgba(0,0,0,.3);}
.fgl-swatch-nm{font-size:9px;color:var(--dim);text-align:center;letter-spacing:.02em;}
.fgl-swatch.on .fgl-swatch-nm{color:var(--gold);}
.fgl-disclose{margin-top:14px;border-top:1px solid var(--line);padding-top:11px;}
.fgl-disclose-head{display:flex;align-items:center;justify-content:space-between;width:100%;cursor:pointer;user-select:none;
  background:transparent;border:0;font-family:var(--mono);color:inherit;text-align:left;padding:0;}
.fgl-disclose-head .fgl-cap{margin-bottom:0;}
.fgl-disclose.collapsed .fgl-chev{transform:rotate(-90deg);}
.fgl-disclose-body{margin-top:11px;}

/* ---- segmented buttons (Scale) ---------------------------------------- */
.fgl-seg{display:flex;gap:2px;background:var(--inset);border:1px solid var(--line);border-radius:4px;padding:2px;}
.fgl-seg.fgl-seg-wrap{flex-wrap:wrap;}
.fgl-seg button{flex:1;border:0;background:transparent;color:var(--dim);font-family:var(--mono);font-size:11px;
  letter-spacing:.06em;padding:6px 4px;border-radius:3px;cursor:pointer;}
.fgl-seg.fgl-seg-wrap button{flex:1 0 auto;padding:6px 9px;}
.fgl-seg button:hover{color:var(--text);}
.fgl-seg button[aria-pressed="true"]{background:var(--gold);color:#161003;font-weight:500;}
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
.fgl-dr{margin-bottom:11px;}
.fgl-dr-head{display:flex;align-items:center;gap:7px;margin-bottom:5px;}
.fgl-sw{width:7px;height:7px;border-radius:2px;}
.fgl-dr-nm{font-size:10.5px;color:var(--text);flex:1;letter-spacing:.03em;}
.fgl-dr-vals{font-size:9.5px;color:var(--dim);font-variant-numeric:tabular-nums;display:flex;align-items:center;gap:3px;}
.fgl-dr-dash{color:var(--faint);}
.fgl-num{width:62px;background:var(--inset);border:1px solid var(--line);border-radius:3px;color:var(--text);
  font-family:var(--mono);font-size:9.5px;text-align:right;padding:2px 4px;outline:none;font-variant-numeric:tabular-nums;}
.fgl-num:focus{border-color:var(--gold-d);}
.fgl-cbar{margin-top:11px;}
.fgl-cbar-strip{height:12px;border-radius:3px;border:1px solid var(--line2);}
.fgl-cbar-axis{position:relative;height:13px;margin-top:3px;}
.fgl-cbar-tick{position:absolute;top:0;font-size:9px;color:var(--dim);font-family:var(--mono);
  font-variant-numeric:tabular-nums;white-space:nowrap;}
.fgl-grat{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:1;}
.fgl-ruler{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:2;}
.fgl-modal{position:fixed;inset:0;z-index:2147483646;background:rgba(2,4,8,.62);display:flex;
  align-items:center;justify-content:center;padding:24px;}
.fgl-hdr{display:flex;flex-direction:column;width:min(640px,92vw);max-height:82vh;background:var(--win);
  border:1px solid var(--line2);border-radius:8px;box-shadow:0 18px 60px rgba(0,0,0,.6);overflow:hidden;}
.fgl-hdr-head{display:flex;align-items:center;justify-content:space-between;padding:11px 14px;
  border-bottom:1px solid var(--line);color:var(--text);font-size:12px;letter-spacing:.04em;}
.fgl-hdr-x{background:transparent;border:none;color:var(--dim);font-size:18px;line-height:1;cursor:pointer;padding:0 4px;}
.fgl-hdr-x:hover{color:var(--gold);}
.fgl-hdr-body{overflow:auto;padding:8px 14px 12px;font-family:var(--mono);font-size:11px;line-height:1.55;}
.fgl-hdr-card{display:flex;gap:7px;white-space:pre-wrap;word-break:break-word;}
.fgl-hdr-card.comment{color:var(--dim);}
.fgl-hdr-k{color:var(--gold);min-width:80px;flex:none;}
.fgl-hdr-eq{color:var(--faint);}
.fgl-hdr-v{color:var(--text);}
.fgl-hdr-c{color:var(--faint);}
.fgl-hdr-msg{color:var(--dim);padding:14px 0;text-align:center;}
.fgl-dr-scanning{font-size:10px;color:var(--faint);padding:6px 0;}
.fgl-dr-track{position:relative;height:32px;}
.fgl-hist{position:absolute;inset:0 0 8px;width:100%;height:24px;border:1px solid var(--line);border-radius:3px;background:var(--inset);}
.fgl-dr-fill{position:absolute;bottom:8px;height:24px;background:rgba(224,173,77,.09);border-left:1px solid var(--gold);border-right:1px solid var(--gold);pointer-events:none;}
.fgl-range{position:absolute;left:0;right:0;bottom:-3px;width:100%;height:16px;margin:0;appearance:none;background:none;pointer-events:none;}
.fgl-range::-webkit-slider-thumb{appearance:none;pointer-events:auto;width:10px;height:17px;border-radius:2px;background:var(--gold);border:1px solid #161003;cursor:ew-resize;}
.fgl-range::-moz-range-thumb{pointer-events:auto;width:10px;height:17px;border-radius:2px;border:1px solid #161003;background:var(--gold);cursor:ew-resize;}
.fgl-tri{display:flex;flex-direction:column;gap:7px;}
.fgl-tri-warn{font-size:9.5px;line-height:1.4;color:var(--gold);background:rgba(224,173,77,.08);
  border:1px solid var(--gold-d);border-radius:4px;padding:5px 7px;}
.fgl-tri-row{display:flex;align-items:center;gap:8px;}
.fgl-tri-lbl{font-size:10px;color:var(--dim);min-width:62px;letter-spacing:.04em;}
.fgl-tri-range{flex:1;appearance:none;height:3px;border-radius:2px;background:var(--line2);cursor:ew-resize;}
.fgl-tri-range::-webkit-slider-thumb{appearance:none;width:10px;height:14px;border-radius:2px;background:var(--gold);border:1px solid #161003;cursor:ew-resize;}
.fgl-tri-range::-moz-range-thumb{width:10px;height:14px;border-radius:2px;background:var(--gold);border:1px solid #161003;cursor:ew-resize;}
.fgl-tri-val{font-size:9.5px;color:var(--text);font-variant-numeric:tabular-nums;min-width:42px;text-align:right;}
.fgl-wmx{display:flex;flex-direction:column;gap:5px;margin-bottom:11px;}
.fgl-wmx-head{display:flex;align-items:center;justify-content:space-between;gap:8px;}
.fgl-wmx-cap{font-size:9px;color:var(--dim);letter-spacing:.1em;text-transform:uppercase;}
.fgl-wmx-cols,.fgl-wrow{display:grid;grid-template-columns:14px 1fr 34px 34px 34px;gap:4px;align-items:center;}
.fgl-wmx-hd{font-size:8.5px;text-align:center;letter-spacing:.04em;}
.fgl-wrow.off{opacity:.5;}
.fgl-wswatch{width:9px;height:9px;border-radius:2px;border:1px solid rgba(0,0,0,.4);display:inline-block;margin-right:5px;vertical-align:middle;}
.fgl-wlbl{font-size:9.5px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.fgl-wchk{cursor:pointer;margin:0;}
.fgl-knob{display:block;margin:0 auto;cursor:ns-resize;touch-action:none;outline:none;overflow:visible;
  -webkit-tap-highlight-color:transparent;-webkit-user-select:none;user-select:none;}
.fgl-knob-well{fill:var(--inset);stroke:var(--line);stroke-width:1;}
.fgl-knob-track{fill:none;stroke:var(--line2);stroke-linecap:round;}
.fgl-knob-fill{fill:none;stroke:var(--knob-color);stroke-linecap:round;
  filter:drop-shadow(0 0 1.5px var(--knob-color));}
.fgl-knob-notch{fill:var(--knob-color);stroke:var(--inset);stroke-width:.6;}
.fgl-knob-num{fill:var(--text);font-family:var(--mono);font-size:9px;font-variant-numeric:tabular-nums;
  letter-spacing:-.02em;pointer-events:none;user-select:none;}
.fgl-knob:hover .fgl-knob-track{stroke:var(--gold-d);}
.fgl-knob:focus-visible .fgl-knob-well{stroke:var(--gold);}
.fgl-knob:focus-visible .fgl-knob-num{fill:var(--gold);}
/* Dimmed (off) rows already get opacity .5 from .fgl-wrow.off; also kill the
   channel glow so a dimmed knob reads as flat/inactive, not lit. */
.fgl-wrow.off .fgl-knob-fill{filter:none;}
.fgl-rainbow{background:transparent;border:1px solid var(--line2);color:var(--dim);font-family:var(--mono);
  font-size:9px;letter-spacing:.1em;text-transform:uppercase;padding:4px 9px;border-radius:4px;cursor:pointer;}
.fgl-rainbow:hover{border-color:var(--gold-d);color:var(--gold);}
.fgl-tg{display:flex;align-items:center;justify-content:space-between;cursor:pointer;width:100%;
  background:transparent;border:0;font-family:var(--mono);color:inherit;text-align:left;padding:0;}
.fgl-tg.off,.fgl-tg:disabled{opacity:.4;cursor:not-allowed;}
.fgl-tx{font-size:11.5px;color:var(--text);letter-spacing:.03em;}
.fgl-switch{width:34px;height:19px;border-radius:10px;background:var(--inset);border:1px solid var(--line2);position:relative;transition:.18s;flex:none;}
.fgl-switch::after{content:"";position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:var(--dim);transition:.18s;}
.fgl-tg.on .fgl-switch{background:var(--gold);border-color:var(--gold);}
.fgl-tg.on .fgl-switch::after{left:17px;background:#161003;}
.fgl-goto{display:flex;gap:6px;}
.fgl-goto-in{flex:1;min-width:0;background:var(--inset);border:1px solid var(--line2);border-radius:4px;color:var(--text);
  font-family:var(--mono);font-size:11px;padding:7px 8px;outline:none;}
.fgl-goto-in::placeholder{color:var(--dim);opacity:.7;}
.fgl-goto-in:focus{border-color:var(--gold-d);}
.fgl-goto-in.err{border-color:#c4543b;}
.fgl-goto-btn{background:transparent;border:1px solid var(--line2);color:var(--dim);font-family:var(--mono);
  font-size:10px;letter-spacing:.1em;text-transform:uppercase;padding:0 12px;border-radius:4px;cursor:pointer;}
.fgl-goto-btn:hover{border-color:var(--gold-d);color:var(--gold);}
.fgl-menu{position:fixed;z-index:2147483647;background:var(--win);border:1px solid var(--line2);border-radius:6px;
  padding:4px;box-shadow:0 8px 28px rgba(0,0,0,.55);}
.fgl-menu-item{display:block;width:100%;text-align:left;background:transparent;border:none;color:var(--text);
  font-family:var(--mono);font-size:11px;padding:7px 13px;border-radius:4px;cursor:pointer;white-space:nowrap;}
.fgl-menu-item:hover{background:var(--inset);color:var(--gold);}
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
