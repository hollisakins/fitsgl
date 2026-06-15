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
  type ResolvedMarker,
  type StretchMode,
  type TilePyramidOptions,
  type TrilogyParams,
  type TrilogyStats,
  type ViewerFrameInfo,
} from '../index.js';
import {
  activeBandNames,
  defaultExplorerState,
  defaultViewFromConfig,
  deriveViewerConfig,
  explorerBandsFromConfig,
  groupBands,
  isBandSelectableForRgb,
  isTrilogyComposite,
  rainbowAction,
  rgbActiveGroup,
  trilogyComposite,
  type ExplorerBand,
  type ExplorerDefaultView,
  type ExplorerState,
} from './explorer-state.js';
import { bandsSignature, viewSignature } from './plan.js';
import { buildShareUrl, decodeShareHash, type ShareState } from './share-url.js';
import { drawGraticule } from './graticule.js';

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
  const [collapsed, setCollapsed] = useState(false);
  const [readyTick, setReadyTick] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
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

  const seed = useCallback(async (): Promise<void> => {
    const v = getViewer();
    if (v === null) return;
    // Trilogy drives its levels from precomputed global stats; still seed the
    // panel histograms below for display. Fall through to percentile only when
    // trilogy could not apply (mode mid-switch or no precomputed stats).
    const trilogyApplied = state.stretch === 'trilogy' && applyTrilogyFromStats(v);
    // Trilogy has no per-channel limit sliders, so skip the percentile auto-stretch
    // AND the histogram readback when it applied (in the weighted composite the
    // histogram would describe the wrong band — the panel doesn't show it anyway).
    const [auto, hist] = await Promise.all([
      trilogyApplied ? Promise.resolve(null) : v.autoStretch(),
      trilogyApplied ? Promise.resolve(null) : v.visibleHistogram(),
    ]);
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
  }, [getViewer, state.mode, state.band, state.rgb.r, state.rgb.g, state.rgb.b, state.stretch, applyTrilogyFromStats]);

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

  const containerStyle =
    props.style === undefined ? ROOT_STYLE : { ...ROOT_STYLE, ...props.style };

  // Right-click over the image opens the share menu; over the control panel the
  // native menu is left alone (so inputs keep paste/select).
  const onStageContextMenu = (e: ReactMouseEvent): void => {
    if ((e.target as HTMLElement).closest('.fgl-win') !== null) return;
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY });
  };

  return (
    <div className={`fgl-explorer${props.className === undefined ? '' : ` ${props.className}`}`} style={containerStyle}>
      {menu !== null && (
        <ShareMenu x={menu.x} y={menu.y} onCopy={makeShareUrl} onClose={() => setMenu(null)} />
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
          <FitsLoadingField active={loading} />
          <div className={`fgl-win${collapsed ? ' collapsed' : ''}`}>
            <div className="fgl-win-head" onClick={() => setCollapsed((c) => !c)}>
              <span className="fgl-win-ttl">Display</span>
              <span className="fgl-chev">▾</span>
            </div>
            <div className="fgl-win-body">
              {/* go to coordinates */}
              <div className="fgl-sec">
                <span className="fgl-cap">Go to</span>
                <GotoBox onGo={goTo} />
              </div>

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
                ) : state.stretch === 'trilogy' ? (
                  <div className="fgl-note" style={{ marginTop: 11 }}>
                    Trilogy composite — choose bands &amp; weights under Scaling below.
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
                  {state.stretch === 'trilogy' ? (
                    <>
                      {state.mode === 'rgb' && (
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
                      )}
                      <TrilogyControls
                        params={state.trilogyParams}
                        missing={activeBandNames(state).some(
                          (n) => bands.find((b) => b.name === n)?.trilogy === undefined,
                        )}
                        onChange={(patch) =>
                          setState((s) => ({ ...s, trilogyParams: { ...s.trilogyParams, ...patch } }))
                        }
                      />
                    </>
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
                  {state.stretch !== 'trilogy' && (
                    <button type="button" className="fgl-auto" onClick={() => void seed()}>
                      Auto-stretch visible
                    </button>
                  )}
                </div>

                {state.mode === 'single' && (
                  <>
                    <div className="fgl-row" style={{ marginTop: 11 }}>
                      <span className="fgl-cap-inline">Colormap</span>
                      <ColormapDropdown
                        value={state.colormap}
                        onChange={(name) => setState((s) => ({ ...s, colormap: name }))}
                      />
                    </div>
                    {state.stretch !== 'trilogy' &&
                      (() => {
                        const lim =
                          limits[state.band] ??
                          (histos[state.band] !== undefined
                            ? { min: histos[state.band]!.lo, max: histos[state.band]!.hi }
                            : undefined);
                        return lim !== undefined ? (
                          <Colorbar
                            min={lim.min}
                            max={lim.max}
                            mode={state.stretch}
                            colormap={state.colormap}
                          />
                        ) : null;
                      })()}
                  </>
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
                  className={`fgl-tg${state.graticule ? ' on' : ''}`}
                  onClick={() => setState((s) => ({ ...s, graticule: !s.graticule }))}
                >
                  <span className="fgl-tx">Coordinate grid</span>
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
                <div className="fgl-btn-row">
                  <button type="button" className="fgl-reset" onClick={() => handle.current?.fitToImage()}>
                    Fit to image
                  </button>
                  <button
                    type="button"
                    className="fgl-reset"
                    onClick={() => {
                      const url = handle.current?.exportPNG();
                      if (url === null || url === undefined) return;
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = `${(title ?? 'fitsgl').replace(/\s+/g, '_')}.png`;
                      a.click();
                    }}
                  >
                    Save PNG
                  </button>
                </div>
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
  version: number;
  listeners: Set<() => void>;
}

function createReadoutStore(): ReadoutStore {
  return { cursor: null, frame: null, version: 0, listeners: new Set() };
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
  const { cursor, frame } = store;
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
.fgl-btn-row{display:flex;gap:7px;}
.fgl-btn-row .fgl-reset{flex:1;}
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
