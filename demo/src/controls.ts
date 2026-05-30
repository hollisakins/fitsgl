/**
 * Demo UI: the top-bar stretch controls + "Auto" button, and the bottom-bar
 * telemetry HUD. Vanilla TypeScript, native inputs — no framework.
 *
 * The viewer renders on demand and reports its state through `onFrame`; this
 * module turns each report into HUD text and uses the reported visible bounds to
 * implement "Auto" (stretch to the 1st–99th percentile of the data currently in
 * view). FPS is derived from the spacing of recent frames and decays to "idle"
 * when nothing is drawing.
 */

import {
  buildLevelGeoms,
  visibleTiles,
  formatRA,
  formatDec,
  COLORMAP_NAMES,
  STRETCH_MODES,
  type ColormapName,
  type CursorInfo,
  type FitsViewer,
  type LevelGeom,
  type Manifest,
  type StretchMode,
  type TilePyramid,
  type ViewerFrameInfo,
} from 'fits-pyramid';

export interface ControlsElements {
  minInput: HTMLInputElement;
  maxInput: HTMLInputElement;
  autoButton: HTMLButtonElement;
  stretchSelect: HTMLSelectElement;
  colormapSelect: HTMLSelectElement;
  northUpCheckbox: HTMLInputElement;
  statZoom: HTMLElement;
  statRaDec: HTMLElement;
  statCenter: HTMLElement;
  statLevel: HTMLElement;
  statCompression: HTMLElement;
  statTiles: HTMLElement;
  statFps: HTMLElement;
  statBytes: HTMLElement;
  status: HTMLElement;
}

/** Show FPS as "idle" once no frame has drawn for this long. */
const IDLE_MS = 400;
/** Cap the sample count for the percentile sort so "Auto" stays snappy. */
const PERCENTILE_SAMPLE_CAP = 1_000_000;

export class DemoControls {
  private viewer: FitsViewer | null = null;
  private readonly geoms: Map<number, LevelGeom>;
  private latest: ViewerFrameInfo | null = null;
  private didInitialAuto = false;
  private readonly frameTimes: number[] = [];
  private readonly telemetryTimer: number;

  constructor(
    private readonly el: ControlsElements,
    private readonly pyramid: TilePyramid,
    private readonly manifest: Manifest,
    private readonly getBytesFetched: () => number,
  ) {
    this.geoms = buildLevelGeoms(manifest);

    this.el.autoButton.addEventListener('click', () => {
      void this.autoStretch();
    });
    const applyStretch = (): void => this.applyManualStretch();
    this.el.minInput.addEventListener('input', applyStretch);
    this.el.maxInput.addEventListener('input', applyStretch);

    // Populate the stretch + colormap pickers from the library's own lists so
    // they stay in sync with what the core actually supports.
    populateSelect(this.el.stretchSelect, STRETCH_MODES, 'linear');
    populateSelect(this.el.colormapSelect, COLORMAP_NAMES, 'gray');
    this.el.stretchSelect.addEventListener('change', () => {
      this.viewer?.setStretchMode(this.el.stretchSelect.value as StretchMode);
    });
    this.el.colormapSelect.addEventListener('change', () => {
      // 'gray' is the built-in grayscale path; any other name uploads a LUT.
      this.viewer?.setColormap(this.el.colormapSelect.value as ColormapName);
    });
    this.el.northUpCheckbox.addEventListener('change', () => {
      this.viewer?.setNorthUp(this.el.northUpCheckbox.checked);
    });

    // Repaint the HUD a few times a second so FPS decays to "idle" and the
    // byte counter keeps ticking even between rendered frames.
    this.telemetryTimer = window.setInterval(() => this.renderTelemetry(), 250);
  }

  /** Wire the viewer in after construction (it needs `onFrame` -> this). */
  setViewer(viewer: FitsViewer): void {
    this.viewer = viewer;
    // Reflect the viewer's default (North-up on when the pyramid has a usable WCS).
    this.el.northUpCheckbox.checked = viewer.isNorthUp;
  }

  /** Called by the viewer on cursor movement; updates the RA/Dec readout. */
  handleCursor(info: CursorInfo | null): void {
    if (info === null || info.ra === null || info.dec === null) {
      this.el.statRaDec.textContent = '—';
      return;
    }
    this.el.statRaDec.textContent = `${formatRA(info.ra)} ${formatDec(info.dec)}`;
  }

  /** Stop the HUD timer. Call on teardown (page unload / Vite HMR dispose). */
  destroy(): void {
    window.clearInterval(this.telemetryTimer);
  }

  /** Called by the viewer at the end of every drawn frame. */
  handleFrame(info: ViewerFrameInfo): void {
    this.latest = info;
    this.frameTimes.push(performance.now());
    if (this.frameTimes.length > 90) this.frameTimes.shift();
    this.renderTelemetry();

    // Default the stretch to the data the moment the first tiles are in view,
    // so the demo opens on a sensibly-stretched image rather than a flat field.
    if (!this.didInitialAuto && info.visibleTileCount > 0) {
      this.didInitialAuto = true;
      void this.autoStretch();
    }
  }

  private applyManualStretch(): void {
    const lo = parseFloat(this.el.minInput.value);
    const hi = parseFloat(this.el.maxInput.value);
    if (this.viewer !== null && Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) {
      this.viewer.setStretch(lo, hi);
    }
  }

  /** Stretch to the 1st–99th percentile of the decoded data currently in view. */
  async autoStretch(): Promise<void> {
    const info = this.latest;
    if (info === null || this.viewer === null) return;
    const geom = this.geoms.get(info.level);
    if (geom === undefined) return;
    const tiles = visibleTiles(geom, info.bounds);
    if (tiles.length === 0) return;

    let arrays: Float32Array[];
    try {
      // These are the same tiles the viewer drew, so they are cache hits.
      arrays = await Promise.all(
        tiles.map((t) => this.pyramid.getTile(info.level, t.tileX, t.tileY)),
      );
    } catch (err) {
      this.setStatus(`Auto-stretch failed: ${(err as Error).message}`, true);
      return;
    }

    const range = percentileRange(arrays, 0.01, 0.99, PERCENTILE_SAMPLE_CAP);
    if (range === null) return;
    const [lo, hi] = range;
    this.viewer.setStretch(lo, hi);
    this.el.minInput.value = formatStretch(lo);
    this.el.maxInput.value = formatStretch(hi);
  }

  private fps(): number {
    const now = performance.now();
    let i = this.frameTimes.length - 1;
    while (i >= 0 && now - this.frameTimes[i] < 1000) i--;
    const window = this.frameTimes.slice(i + 1);
    if (window.length < 2) return 0;
    const span = window[window.length - 1] - window[0];
    return span > 0 ? ((window.length - 1) / span) * 1000 : 0;
  }

  private renderTelemetry(): void {
    const info = this.latest;
    const dpr = window.devicePixelRatio || 1;
    if (info !== null) {
      // `zoom` is drawing-buffer px per world px; dividing by dpr gives the
      // CSS-pixel "× native" the user perceives.
      this.el.statZoom.textContent = `${(info.zoom / dpr).toFixed(3)}×`;
      this.el.statCenter.textContent = `(${Math.round(info.centerX)}, ${Math.round(info.centerY)})`;
      this.el.statLevel.textContent = `z=${info.level}`;
      this.el.statTiles.textContent = String(info.visibleTileCount);
      const lvl = this.manifest.levels.find((l) => l.z === info.level);
      // `compression` defaults to '' when a manifest omits it; show a placeholder.
      this.el.statCompression.textContent =
        lvl !== undefined && lvl.compression !== '' ? lvl.compression : '—';
    }

    const last = this.frameTimes[this.frameTimes.length - 1];
    const idle = info === null || last === undefined || performance.now() - last > IDLE_MS;
    const f = this.fps();
    this.el.statFps.textContent = idle || f === 0 ? 'idle' : f.toFixed(0);
    this.el.statBytes.textContent = formatBytes(this.getBytesFetched());
  }

  private setStatus(message: string, isError: boolean): void {
    this.el.status.textContent = message;
    this.el.status.classList.toggle('error', isError);
    this.el.status.classList.toggle('hidden', message === '');
  }
}

/**
 * 1st/99th-percentile pair over the finite values across `arrays`. Subsamples
 * with a fixed stride when the total exceeds `cap` so a wide viewport's sort
 * stays cheap. Returns null when there is no finite data or the range collapses.
 */
export function percentileRange(
  arrays: Float32Array[],
  pLo: number,
  pHi: number,
  cap: number,
): [number, number] | null {
  let total = 0;
  for (const a of arrays) total += a.length;
  if (total === 0) return null;
  const stride = total > cap ? Math.ceil(total / cap) : 1;

  const vals: number[] = [];
  let idx = 0;
  for (const a of arrays) {
    for (let i = 0; i < a.length; i++, idx++) {
      if (stride > 1 && idx % stride !== 0) continue;
      const v = a[i];
      if (Number.isFinite(v)) vals.push(v);
    }
  }
  if (vals.length === 0) return null;
  vals.sort((x, y) => x - y);

  const at = (p: number): number =>
    vals[Math.min(vals.length - 1, Math.max(0, Math.round(p * (vals.length - 1))))];
  const lo = at(pLo);
  const hi = at(pHi);
  if (!(hi > lo)) return null;
  return [lo, hi];
}

/** Fill a <select> with `options`, selecting `selected`. */
function populateSelect(select: HTMLSelectElement, options: readonly string[], selected: string): void {
  select.replaceChildren(
    ...options.map((name) => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      if (name === selected) opt.selected = true;
      return opt;
    }),
  );
}

function formatStretch(v: number): string {
  // Trim to ~5 significant figures without scientific-notation noise for the input box.
  return String(Number(v.toPrecision(5)));
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
