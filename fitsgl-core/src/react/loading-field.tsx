/**
 * `<FitsLoadingField>` — a boot/placeholder overlay for the viewer.
 *
 * A monochrome field is assembled tile-by-tile on the viewer's black: each tile
 * arrives as chunky low-resolution pixels and refines in place through pyramid
 * levels (coarse → fine), echoing how the core streams coarse tiles first and
 * sharpens them. It is purely decorative — a *stand-in* shown while the real
 * pyramids load — and reads no viewer state; the host toggles `active` off once
 * the viewer is ready (see the usage note below).
 *
 * Design notes, mirroring the rest of this tier:
 *  - **Self-contained.** No props are required; no viewer/core imports. It draws a
 *    procedurally-generated grayscale field to a `<canvas>` and centres itself over
 *    whatever sizes it (the `<FitsViewer>` container is `position: relative`, so it
 *    drops in as a `children` overlay). Styling is injected once via `ensureStyles`,
 *    the same pattern `<FitsExplorer>` uses, under `fgl-load-*` classes.
 *  - **Controlled by one boolean.** `active` is the whole contract: true animates;
 *    false fades the overlay out (CSS opacity) and then parks the rAF loop, so a
 *    loaded viewer pays nothing. Flipping it back to true restarts the load
 *    animation from a fresh coarse state.
 *  - **Imperative escape hatch.** A `ref` exposes `restart()` for hosts that want to
 *    replay the animation on a manual reload without unmounting.
 *
 * Wiring it to the real load (host's choice of "ready"):
 *
 *   const [loading, setLoading] = useState(true);
 *   // `onReady` fires when the viewer is *constructed*; `onFrame` (first call)
 *   // fires when actual pixels have drawn. Hide on the first frame for the most
 *   // honest hand-off — the placeholder gives way exactly as the image appears.
 *   const seen = useRef(false);
 *   <FitsViewer
 *     config={config}
 *     onFrame={() => { if (!seen.current) { seen.current = true; setLoading(false); } }}
 *     onError={() => setLoading(false)}
 *   >
 *     <FitsLoadingField active={loading} />
 *   </FitsViewer>
 */

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import type { CSSProperties } from 'react';

// ---------------------------------------------------------------------------
// Engine — a plain (non-React) canvas simulation. Owns its own clock + loop and
// is driven one `frame(now)` at a time by the component's rAF.
// ---------------------------------------------------------------------------

/** Deterministic PRNG so the field + reveal order are stable across reloads. */
function mulberry32(a: number): () => number {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
const smooth = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

interface FieldParams {
  cols: number;
  rows: number;
  /** Chunkiness multiplier on the coarse pyramid levels (1 = as designed). */
  grain: number;
  /** Seam-highlight colour for freshly-arrived tiles, e.g. '#e0ad4d'. */
  accent: string;
}

/** Pixels-across-a-tile per pyramid level, coarse → fine. */
const LEVELS = [3, 6, 12, 24] as const;

class PixelTileField {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly tmp: HTMLCanvasElement;
  private readonly tctx: CanvasRenderingContext2D;
  private src!: HTMLCanvasElement;
  private start!: number[];
  private refineDur = 0.3;
  private dpr = Math.min(window.devicePixelRatio || 1, 2);
  private t0 = performance.now();
  private W = 0;
  private H = 0;
  private accCache: { hex: string; rgb: string } | null = null;

  /** Loop length in ms (the host sets this from a `speed` prop). */
  loopMs = 6250;

  constructor(private readonly canvas: HTMLCanvasElement, readonly params: FieldParams) {
    this.ctx = must2d(canvas);
    this.tmp = document.createElement('canvas');
    this.tctx = must2d(this.tmp);
    this.buildSource();
    this.buildOrder();
    this.resize();
  }

  /** A monochrome "deep field": faint diffuse glow + scattered bright points. */
  private buildSource(): void {
    const S = 512;
    const c = document.createElement('canvas');
    c.width = S;
    c.height = Math.round((S * this.params.rows) / this.params.cols);
    const H = c.height;
    const g = must2d(c);
    g.fillStyle = '#000';
    g.fillRect(0, 0, S, H);
    const r = mulberry32(0x5eed);
    g.globalCompositeOperation = 'lighter';
    // a few faint diffuse smudges (galaxies / cirrus)
    for (let i = 0; i < 4; i++) {
      const x = r() * S;
      const y = r() * H;
      const rad = (0.12 + r() * 0.22) * S;
      const lum = 8 + r() * 16;
      const grd = g.createRadialGradient(x, y, 0, x, y, rad);
      grd.addColorStop(0, `rgba(255,255,255,${lum / 255})`);
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd;
      g.fillRect(0, 0, S, H);
    }
    // stars: many faint, a few bright
    for (let i = 0; i < 520; i++) {
      const x = r() * S;
      const y = r() * H;
      const b = Math.pow(r(), 2.2);
      const rad = 0.6 + b * 4.2;
      const lum = 40 + b * 215;
      const grd = g.createRadialGradient(x, y, 0, x, y, rad);
      grd.addColorStop(0, `rgba(255,255,255,${lum / 255})`);
      grd.addColorStop(0.5, `rgba(255,255,255,${(lum / 255) * 0.4})`);
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd;
      g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
    g.globalCompositeOperation = 'source-over';
    this.src = c;
  }

  /** Centre-out (with jitter) arrival order; each cell gets a normalized start. */
  private buildOrder(): void {
    const { cols, rows } = this.params;
    const n = cols * rows;
    const r = mulberry32(0xa17 ^ n);
    const idx = [...Array(n).keys()];
    const cx = (cols - 1) / 2;
    const cy = (rows - 1) / 2;
    idx.sort((a, b) => {
      const da = Math.hypot((a % cols) - cx, ((a / cols) | 0) - cy) + r() * 1.4;
      const db = Math.hypot((b % cols) - cx, ((b / cols) | 0) - cy) + r() * 1.4;
      return da - db;
    });
    this.start = new Array<number>(n);
    idx.forEach((cell, rank) => {
      // tiles arrive across the first ~58% of the loop
      this.start[cell] = (rank / n) * 0.58;
    });
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(2, Math.round(rect.width * this.dpr));
    const h = Math.max(2, Math.round(rect.height * this.dpr));
    if (w === this.W && h === this.H) return;
    this.W = w;
    this.H = h;
    this.canvas.width = w;
    this.canvas.height = h;
  }

  /** Reset the clock — replays the load from a fresh coarse state. */
  restart(): void {
    this.t0 = performance.now();
  }

  frame(now: number): void {
    this.resize();
    const { W, H } = this;
    const { cols, rows } = this.params;
    const p = ((now - this.t0) % this.loopMs) / this.loopMs;
    const ctx = this.ctx;
    ctx.fillStyle = '#04060c';
    ctx.fillRect(0, 0, W, H);

    const cw = W / cols;
    const ch = H / rows;
    const accent = this.accentRGB();
    const maxLi = LEVELS.length - 1;
    const line = Math.max(1, this.dpr);

    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const cell = cy * cols + cx;
        const st = this.start[cell];
        const tx = cx * cw;
        const ty = cy * ch;
        // placeholder slot for tiles not yet arrived
        if (p < st) {
          ctx.fillStyle = 'rgba(150,170,210,0.035)';
          ctx.fillRect(tx + 1, ty + 1, cw - 2, ch - 2);
          ctx.strokeStyle = 'rgba(150,170,210,0.07)';
          ctx.lineWidth = line;
          ctx.strokeRect(tx + 0.5, ty + 0.5, cw - 1, ch - 1);
          continue;
        }
        const tp = clamp((p - st) / this.refineDur, 0, 1);
        const li = Math.min(maxLi, Math.floor(tp * maxLi + 1e-4));
        const baseR = Math.max(2, Math.round(LEVELS[li] * this.params.grain));
        const rw = baseR;
        const rh = Math.max(1, Math.round(baseR * (ch / cw)));
        // source sub-rect for this tile
        const sx = (cx / cols) * this.src.width;
        const sy = (cy / rows) * this.src.height;
        const sw = this.src.width / cols;
        const sh = this.src.height / rows;
        // downsample into temp, then nearest-neighbour upscale = chunky pixels
        if (this.tmp.width !== rw || this.tmp.height !== rh) {
          this.tmp.width = rw;
          this.tmp.height = rh;
        }
        this.tctx.clearRect(0, 0, rw, rh);
        this.tctx.imageSmoothingEnabled = true;
        this.tctx.drawImage(this.src, sx, sy, sw, sh, 0, 0, rw, rh);
        const entrance = smooth(0, 0.12, tp);
        ctx.globalAlpha = 0.25 + 0.75 * entrance;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(this.tmp, 0, 0, rw, rh, tx, ty, cw, ch);
        ctx.globalAlpha = 1;
        // seam: accent on freshly-arrived tiles, fading as they refine
        const fresh = 1 - smooth(0, 0.55, tp);
        ctx.lineWidth = line;
        ctx.strokeStyle =
          fresh > 0.02 ? `rgba(${accent},${0.12 + 0.7 * fresh})` : 'rgba(150,170,210,0.08)';
        ctx.strokeRect(tx + 0.5, ty + 0.5, cw - 1, ch - 1);
      }
    }
    ctx.imageSmoothingEnabled = true;
  }

  private accentRGB(): string {
    if (this.accCache && this.accCache.hex === this.params.accent) return this.accCache.rgb;
    const h = this.params.accent.replace('#', '');
    const rgb = `${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)}`;
    this.accCache = { hex: this.params.accent, rgb };
    return rgb;
  }
}

function must2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = c.getContext('2d');
  if (ctx === null) throw new Error('FitsLoadingField: 2D canvas context unavailable');
  return ctx;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface FitsLoadingFieldHandle {
  /** Replay the load animation from a fresh coarse state. */
  restart(): void;
}

export interface FitsLoadingFieldProps {
  /** Animate + show (true) or fade out + park the loop (false). Default `true`. */
  active?: boolean;
  /** Centred caption under the field. Pass '' to hide it. Default `'Loading'`. */
  label?: string;
  /** Seam-highlight + pulse-dot colour. Default `'#e0ad4d'` (the viewer gold). */
  accent?: string;
  /** Loop-duration multiplier (higher = faster). Default `0.8`. */
  speed?: number;
  /** Coarse-pixel chunkiness multiplier. Default `1`. */
  grain?: number;
  /** Tile grid dimensions. Default `7 × 5`. */
  cols?: number;
  rows?: number;
  /** Field width in CSS px; height follows the grid aspect. Default `384`. */
  size?: number;
  /** Class for the overlay root (covers the viewer; flex-centres its content). */
  className?: string;
  /** Inline style merged over the overlay root defaults. */
  style?: CSSProperties;
}

const STYLE_ID = 'fgl-load-style';
const STYLE_CSS = `
.fgl-load{position:absolute;inset:0;z-index:3;display:flex;flex-direction:column;
  align-items:center;justify-content:center;gap:18px;pointer-events:none;
  transition:opacity .42s ease;
  font-family:'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,monospace;}
.fgl-load.is-hidden{opacity:0;}
.fgl-load-grid{position:relative;}
.fgl-load-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;image-rendering:pixelated;}
.fgl-load-row{display:flex;align-items:center;gap:9px;}
.fgl-load-dot{width:5px;height:5px;border-radius:50%;background:var(--fgl-load-accent,#e0ad4d);
  box-shadow:0 0 7px var(--fgl-load-accent,#e0ad4d);animation:fgl-load-pulse 1.2s ease-in-out infinite;flex:none;}
.fgl-load-txt{font-size:10.5px;letter-spacing:.34em;text-transform:uppercase;color:#828ca3;
  font-weight:400;text-indent:.34em;}
@keyframes fgl-load-pulse{0%,100%{opacity:1;}50%{opacity:.2;}}
@media (prefers-reduced-motion: reduce){.fgl-load-dot{animation:none;}}
`;

function ensureStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID) !== null) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = STYLE_CSS;
  document.head.appendChild(el);
}

const BASE_STYLE: CSSProperties = {};

const FitsLoadingFieldComponent = forwardRef<FitsLoadingFieldHandle, FitsLoadingFieldProps>(
  function FitsLoadingField(props, ref) {
    const {
      active = true,
      label = 'Loading',
      accent = '#e0ad4d',
      speed = 0.8,
      grain = 1,
      cols = 7,
      rows = 5,
      size = 384,
    } = props;

    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const rootRef = useRef<HTMLDivElement | null>(null);
    const fieldRef = useRef<PixelTileField | null>(null);
    // Latest tunables, read inside the rAF loop without re-subscribing it.
    const tune = useRef({ accent, speed, grain });
    tune.current = { accent, speed, grain };

    useEffect(ensureStyles, []);

    useImperativeHandle(ref, () => ({ restart: () => fieldRef.current?.restart() }), []);

    // Engine + render loop: created once, lives for the component's lifetime. The
    // loop parks itself when the overlay is fully hidden and wakes on `active`.
    useEffect(() => {
      const canvas = canvasRef.current;
      if (canvas === null) return;
      // Decorative-only: if a 2D context is unavailable (SSR/jsdom/context loss)
      // skip the engine entirely rather than throw — the label still renders and
      // the host viewer is never taken down by the placeholder.
      if (canvas.getContext('2d') === null) return;
      const field = new PixelTileField(canvas, { cols, rows, grain, accent });
      fieldRef.current = field;

      let raf = 0;
      let running = false;
      const tick = (now: number): void => {
        const t = tune.current;
        field.params.grain = t.grain;
        field.params.accent = t.accent;
        field.loopMs = 5000 / Math.max(0.25, t.speed);
        field.frame(now);
        raf = requestAnimationFrame(tick);
      };
      const start = (): void => {
        if (running) return;
        running = true;
        raf = requestAnimationFrame(tick);
      };
      const stop = (): void => {
        running = false;
        cancelAnimationFrame(raf);
      };
      // Expose start/stop to the active-effect via the field instance.
      (field as unknown as { _start: () => void; _stop: () => void })._start = start;
      (field as unknown as { _start: () => void; _stop: () => void })._stop = stop;
      start();

      const ro =
        typeof ResizeObserver !== 'undefined'
          ? new ResizeObserver(() => field.resize())
          : null;
      ro?.observe(canvas);

      return () => {
        stop();
        ro?.disconnect();
        fieldRef.current = null;
      };
      // Grid shape is construction-time; a cols/rows change remounts the engine.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cols, rows]);

    // Fade + park: when `active` flips false, fade out then stop the loop after the
    // CSS transition; flipping back true restarts from a fresh coarse state.
    useEffect(() => {
      const field = fieldRef.current as
        | (PixelTileField & { _start?: () => void; _stop?: () => void })
        | null;
      if (field === null) return;
      let timer = 0;
      if (active) {
        field.restart();
        field._start?.();
      } else {
        timer = window.setTimeout(() => field._stop?.(), 460);
      }
      return () => window.clearTimeout(timer);
    }, [active]);

    const gridStyle: CSSProperties = { width: size, height: Math.round((size * rows) / cols) };
    const rootStyle: CSSProperties = {
      ...BASE_STYLE,
      ['--fgl-load-accent' as string]: accent,
      ...(props.style ?? {}),
    };

    return (
      <div
        ref={rootRef}
        className={`fgl-load${active ? '' : ' is-hidden'}${props.className ? ' ' + props.className : ''}`}
        style={rootStyle}
        aria-hidden={!active}
      >
        <div className="fgl-load-grid" style={gridStyle}>
          <canvas ref={canvasRef} className="fgl-load-canvas" />
        </div>
        {label !== '' && (
          <div className="fgl-load-row" role="status" aria-live="polite">
            <span className="fgl-load-dot" />
            <span className="fgl-load-txt">{label}</span>
          </div>
        )}
      </div>
    );
  },
);

FitsLoadingFieldComponent.displayName = 'FitsLoadingField';

export const FitsLoadingField = FitsLoadingFieldComponent;
export default FitsLoadingFieldComponent;
