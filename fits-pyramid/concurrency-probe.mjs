/**
 * Concurrency probe (investigation only — not part of the library build).
 *
 * Drives the REAL inline TileEngine path (injecting `rangeFetch` forces
 * TilePyramid to skip the worker and run the engine inline — exactly the demo's
 * measurement path) and fires a viewport's worth of getTile() calls the way
 * TileManager.request does: all at once, without awaiting between them. The
 * injected range fetcher reads bytes off disk but adds a fixed simulated network
 * latency so request overlap is observable, and tracks how many fetches are
 * in-flight simultaneously (max concurrency) plus per-fetch dispatch/complete
 * timestamps and byte ranges.
 *
 * Run: node concurrency-probe.mjs
 */
import { readFileSync, openSync, readSync, closeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TilePyramid } from './dist/index.js';

const MANIFEST = new URL(
  '../demo/public/pyramid/f150w/manifest.json',
  import.meta.url,
).href;

const SIM_LATENCY_MS = 25; // simulate a warm CDN edge RTT so overlap is visible

// ---- instrumentation -------------------------------------------------------
let inFlight = 0;
let maxInFlight = 0;
let totalFetches = 0;
let totalBytes = 0;
const events = []; // { url, start, end, len }
const t0 = performance.now();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Custom fetch for the manifest JSON only. */
const fetchImpl = async (url) => {
  const path = fileURLToPath(url);
  const text = readFileSync(path, 'utf8');
  return { ok: true, status: 200, json: async () => JSON.parse(text) };
};

/** Instrumented range fetcher: reads [start,end] off disk + simulated latency. */
const rangeFetch = async (url, start, endInclusive) => {
  const dispatch = performance.now() - t0;
  inFlight++;
  totalFetches++;
  if (inFlight > maxInFlight) maxInFlight = inFlight;
  await sleep(SIM_LATENCY_MS);
  const path = fileURLToPath(url);
  const len = endInclusive - start + 1;
  const buf = Buffer.alloc(len);
  const fd = openSync(path, 'r');
  readSync(fd, buf, 0, len, start);
  closeSync(fd);
  totalBytes += len;
  const done = performance.now() - t0;
  inFlight--;
  events.push({ url: path.split('/').pop(), start, len, dispatch, done });
  return new Uint8Array(buf);
};

async function scenario(label, level, tiles) {
  // fresh pyramid per scenario => cold caches (new file open + index fetch)
  inFlight = 0; maxInFlight = 0; totalFetches = 0; totalBytes = 0;
  events.length = 0;
  const pyramid = await TilePyramid.load(MANIFEST, { rangeFetch, fetchImpl });
  const start = performance.now();
  // Fire ALL tile requests at once — exactly how TileManager.request is called
  // in the draw loop's for-loop (no await between iterations).
  const promises = tiles.map(([x, y]) => pyramid.getTile(level, x, y));
  await Promise.all(promises);
  const wall = performance.now() - start;

  console.log(`\n=== ${label} ===`);
  console.log(`tiles requested:      ${tiles.length}`);
  console.log(`total range fetches:  ${totalFetches}`);
  console.log(`max concurrent fetch: ${maxInFlight}`);
  console.log(`bytes fetched:        ${(totalBytes / 1024).toFixed(1)} KB`);
  console.log(`wall time:            ${wall.toFixed(1)} ms  (sim latency ${SIM_LATENCY_MS} ms/fetch)`);
  console.log(`ideal if serial:      ${(totalFetches * SIM_LATENCY_MS).toFixed(0)} ms   ideal if parallel: ~${SIM_LATENCY_MS} ms/round`);
  // Dispatch timeline: group fetches into "rounds" by dispatch time.
  const sorted = [...events].sort((a, b) => a.dispatch - b.dispatch);
  console.log('dispatch timeline (ms @dispatch -> @done, file, bytes):');
  for (const e of sorted.slice(0, 8)) {
    console.log(`  ${e.dispatch.toFixed(1).padStart(7)} -> ${e.done.toFixed(1).padStart(7)}  ${e.url}  ${(e.len/1024).toFixed(1)}KB`);
  }
  if (sorted.length > 8) console.log(`  ... (${sorted.length - 8} more)`);
  pyramid.destroy?.();
}

// z3 = 4x4 = 16 tiles; request the whole level (a plausible zoomed-out viewport).
const z3all = [];
for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) z3all.push([x, y]);

// z2 = 8x8 = 64 tiles; request a 5x5 = 25-tile sub-viewport (a fine-level pan).
const z2vp = [];
for (let y = 1; y < 6; y++) for (let x = 1; x < 6; x++) z2vp.push([x, y]);

await scenario('z3 cold: 16 tiles fired concurrently (whole level)', 3, z3all);
await scenario('z2 cold: 25-tile viewport fired concurrently', 2, z2vp);

// Warm re-request: same tiles again on a fresh pyramid would be cold; instead
// re-request on the SAME pyramid to show cache hits => 0 fetches.
const warm = await TilePyramid.load(MANIFEST, { rangeFetch, fetchImpl });
await Promise.all(z3all.map(([x, y]) => warm.getTile(3, x, y))); // prime
inFlight = 0; maxInFlight = 0; totalFetches = 0; totalBytes = 0; events.length = 0;
await Promise.all(z3all.map(([x, y]) => warm.getTile(3, x, y))); // re-request
console.log(`\n=== z3 warm re-request (same pyramid, cache hit) ===`);
console.log(`tiles requested:      16`);
console.log(`total range fetches:  ${totalFetches}  (expect 0 — served from decoded LRU)`);
warm.destroy?.();
