/**
 * Percentile auto-stretch math (M5) — promoted from the demo into the core so a
 * "stretch to the data in view" action is a supported capability, not something
 * a host re-implements by reaching into the internal tile-selection helpers
 * (decision D11). Pure: operates on decoded tile arrays, no GL/DOM/IO.
 *
 * `FitsViewer.autoStretch` gathers the tiles currently in view and feeds them
 * here; the gather (which tiles, fetched from which pyramid) stays in the viewer
 * because only it knows the frame's level + bounds.
 */

/** Default cap on the sampled value count so a wide viewport's sort stays cheap. */
export const PERCENTILE_SAMPLE_CAP = 1_000_000;

/**
 * The `[pLo, pHi]`-percentile pair over the finite values across `arrays`
 * (e.g. `pLo = 0.01`, `pHi = 0.99`). Subsamples with a fixed stride when the
 * total exceeds `cap` so the sort stays cheap on a wide viewport. Returns `null`
 * when there is no finite data or the range collapses (`hi <= lo`).
 */
export function percentileRange(
  arrays: readonly Float32Array[],
  pLo: number,
  pHi: number,
  cap: number = PERCENTILE_SAMPLE_CAP,
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

/**
 * Bin the finite values across `arrays` into `bins` equal-width buckets over the
 * half-open data domain `[lo, hi)` (the last bucket includes `hi`). Values outside
 * the domain are ignored — pair with a robust `[lo, hi]` (e.g. a wide
 * `percentileRange`) so a few hot pixels don't flatten the histogram. Subsamples
 * with a fixed stride past `cap`, exactly like `percentileRange`, so a wide
 * viewport stays cheap. Returns raw counts; the UI scales them (log) for display.
 *
 * Pure (no GL/DOM/IO): the viewer gathers the visible tiles and feeds them here,
 * the same split as `percentileRange`.
 */
export function histogram(
  arrays: readonly Float32Array[],
  bins: number,
  lo: number,
  hi: number,
  cap: number = PERCENTILE_SAMPLE_CAP,
): Float32Array {
  const counts = new Float32Array(Math.max(1, bins | 0));
  const n = counts.length;
  const span = hi - lo;
  if (!(span > 0)) return counts;

  let total = 0;
  for (const a of arrays) total += a.length;
  const stride = total > cap ? Math.ceil(total / cap) : 1;
  const scale = n / span;

  let idx = 0;
  for (const a of arrays) {
    for (let i = 0; i < a.length; i++, idx++) {
      if (stride > 1 && idx % stride !== 0) continue;
      const v = a[i];
      if (!Number.isFinite(v) || v < lo || v > hi) continue;
      // v === hi lands in bin n (out of range); clamp it into the last bucket.
      const b = Math.min(n - 1, Math.floor((v - lo) * scale));
      counts[b]++;
    }
  }
  return counts;
}
