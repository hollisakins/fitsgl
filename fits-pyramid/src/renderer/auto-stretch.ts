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
