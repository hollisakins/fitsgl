/**
 * Demo UI: the top-bar stretch controls + "Auto" button, and the bottom-bar
 * telemetry HUD. Vanilla TypeScript, native inputs — no framework.
 *
 * The viewer renders on demand and reports its state through `onFrame`; this
 * module turns each report into HUD text. "Auto" is delegated to
 * `FitsViewer.autoStretch` (which samples the data currently in view); this module
 * just reflects the result in the min/max inputs. FPS is derived from the spacing
 * of recent frames and decays to "idle" when nothing is drawing.
 */

import {
  formatRA,
  formatDec,
  COLORMAP_NAMES,
  STRETCH_MODES,
  compatibleBands,
  type AutoStretchResult,
  type ColormapName,
  type CursorInfo,
  type DatasetManifest,
  type FitsViewer,
  type Manifest,
  type MarkerInput,
  type RenderSource,
  type StretchMode,
  type TilePyramid,
  type ViewerFrameInfo,
} from '@fitsgl/core';

/** Which RGB channel the min/max inputs currently edit. */
type Channel = 'r' | 'g' | 'b';

export interface ControlsElements {
  minInput: HTMLInputElement;
  maxInput: HTMLInputElement;
  autoButton: HTMLButtonElement;
  stretchSelect: HTMLSelectElement;
  colormapSelect: HTMLSelectElement;
  northUpCheckbox: HTMLInputElement;
  markersCheckbox: HTMLInputElement;
  rgbCheckbox: HTMLInputElement;
  bandRSelect: HTMLSelectElement;
  bandGSelect: HTMLSelectElement;
  bandBSelect: HTMLSelectElement;
  channelSelect: HTMLSelectElement;
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

export class DemoControls {
  private viewer: FitsViewer | null = null;
  private catalog: MarkerInput[] = [];
  private latest: ViewerFrameInfo | null = null;
  private didInitialAuto = false;
  private readonly frameTimes: number[] = [];
  private readonly telemetryTimer: number;

  // ---- RGB compositing (M4) ----------------------------------------------
  private readonly bandPyramids = new Map<string, TilePyramid>();
  /** Current R/G/B band-name assignment (null until a dataset is provided). */
  private roles: { r: string; g: string; b: string } | null = null;
  /** Which channel the min/max inputs edit while in RGB mode. */
  private channel: Channel = 'r';
  /** Auto-computed [min,max] per band name, reused when a band fills a role. */
  private readonly bandStretch = new Map<string, [number, number]>();

  constructor(
    private readonly el: ControlsElements,
    private readonly pyramid: TilePyramid,
    private readonly manifest: Manifest,
    private readonly getBytesFetched: () => number,
  ) {
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
    this.el.markersCheckbox.disabled = true; // enabled once a catalog loads
    this.el.markersCheckbox.addEventListener('change', () => this.applyMarkers());

    // RGB controls stay disabled until a dataset (3+ bands) is provided.
    this.el.rgbCheckbox.disabled = true;
    this.el.rgbCheckbox.addEventListener('change', () => this.onRgbToggle());
    this.el.bandRSelect.addEventListener('change', () => this.onRoleChange());
    this.el.bandGSelect.addEventListener('change', () => this.onRoleChange());
    this.el.bandBSelect.addEventListener('change', () => this.onRoleChange());
    this.el.channelSelect.addEventListener('change', () => {
      this.channel = this.el.channelSelect.value as Channel;
      this.loadChannelStretchIntoInputs();
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

  /** Provide the overlay catalog; markers default on when present. */
  setCatalog(markers: MarkerInput[]): void {
    this.catalog = markers;
    const has = markers.length > 0;
    this.el.markersCheckbox.disabled = !has;
    this.el.markersCheckbox.checked = has;
    this.applyMarkers();
  }

  private applyMarkers(): void {
    if (this.viewer === null) return;
    if (this.el.markersCheckbox.checked && this.catalog.length > 0) {
      this.viewer.setMarkers(this.catalog);
    } else {
      this.viewer.clearMarkers();
    }
  }

  // ---- RGB compositing (M4) ----------------------------------------------

  /**
   * Provide the dataset bands; enables the RGB toggle and the R/G/B band
   * pickers. The view stays single-band until the toggle is switched on.
   */
  setDataset(dataset: DatasetManifest, pyramids: Map<string, TilePyramid>): void {
    this.bandPyramids.clear();
    for (const [name, p] of pyramids) this.bandPyramids.set(name, p);

    // Offer only bands that share a grid with the first band (the picker rule).
    const choices = compatibleBands(dataset.bands[0], dataset.bands).map((b) => b.name);
    if (choices.length < 3) return; // need three bands to composite

    const def = dataset.default_rgb ?? { r: choices[0], g: choices[1], b: choices[2] };
    this.roles = { r: def.r, g: def.g, b: def.b };
    populateSelect(this.el.bandRSelect, choices, this.roles.r);
    populateSelect(this.el.bandGSelect, choices, this.roles.g);
    populateSelect(this.el.bandBSelect, choices, this.roles.b);
    this.el.rgbCheckbox.disabled = false;
  }

  private onRgbToggle(): void {
    if (this.viewer === null || this.roles === null) return;
    const on = this.el.rgbCheckbox.checked;
    document.body.classList.toggle('rgb-mode', on);
    if (on) {
      void this.enterRgb();
    } else {
      // Back to single-band on the representative pyramid (the viewer was built
      // single-band on it; setSource preserves the grid). The min/max inputs keep
      // the single-band stretch they already showed; "Auto" re-derives on demand.
      this.viewer.setSource({ kind: 'single', pyramid: this.pyramid });
    }
  }

  private onRoleChange(): void {
    if (this.roles === null) return;
    this.roles = {
      r: this.el.bandRSelect.value,
      g: this.el.bandGSelect.value,
      b: this.el.bandBSelect.value,
    };
    if (this.el.rgbCheckbox.checked) void this.enterRgb();
  }

  /** Build the RGB source from the current roles, then auto-stretch + sync inputs. */
  private async enterRgb(): Promise<void> {
    if (this.viewer === null || this.roles === null) return;
    const source = this.rgbSource(this.roles);
    if (source === null) return;
    this.viewer.setSource(source);
    await this.autoStretch(); // viewer.autoStretch handles RGB; we cache + fill inputs
  }

  private rgbSource(roles: { r: string; g: string; b: string }): RenderSource | null {
    const r = this.bandPyramids.get(roles.r);
    const g = this.bandPyramids.get(roles.g);
    const b = this.bandPyramids.get(roles.b);
    if (r === undefined || g === undefined || b === undefined) return null;
    return { kind: 'rgb', r, g, b };
  }

  /** Reflect the selected channel's band stretch in the min/max inputs. */
  private loadChannelStretchIntoInputs(): void {
    if (this.roles === null) return;
    const range = this.bandStretch.get(this.roles[this.channel]);
    if (range === undefined) return;
    this.el.minInput.value = formatStretch(range[0]);
    this.el.maxInput.value = formatStretch(range[1]);
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
    if (this.viewer === null || !Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return;
    if (this.el.rgbCheckbox.checked && this.roles !== null) {
      // RGB: the inputs edit the currently-selected channel only (independence).
      this.viewer.setChannelStretch(this.channel, lo, hi);
      this.bandStretch.set(this.roles[this.channel], [lo, hi]);
    } else {
      this.viewer.setStretch(lo, hi);
    }
  }

  /** "Auto": stretch to the data in view (per-channel in RGB), via the viewer. */
  async autoStretch(): Promise<void> {
    if (this.viewer === null) return;
    const result = await this.viewer.autoStretch();
    if (result !== null) this.applyAutoResultToInputs(result);
  }

  /** Reflect an auto-stretch result in the inputs; cache RGB ranges per band name. */
  private applyAutoResultToInputs(result: AutoStretchResult): void {
    if (result.mode === 'single') {
      this.el.minInput.value = formatStretch(result.min);
      this.el.maxInput.value = formatStretch(result.max);
      return;
    }
    if (this.roles !== null) {
      for (const ch of ['r', 'g', 'b'] as const) {
        const range = result[ch];
        if (range !== null) this.bandStretch.set(this.roles[ch], range);
      }
    }
    this.loadChannelStretchIntoInputs();
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
