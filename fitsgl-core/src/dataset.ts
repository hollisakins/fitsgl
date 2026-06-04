/**
 * Dataset manifest — groups single-band pyramids for RGB compositing (M4, D9).
 *
 * An ADDITIVE sidecar that sits above the per-pyramid `manifest.json` files: it
 * lists the available bands with their canonical z=0 grid parameters + a grid
 * hash, plus an optional default RGB role assignment. The per-pyramid manifest
 * schema is unchanged and every existing single-band pyramid stays valid; a band
 * is still a normal, independently renderable pyramid.
 *
 * Carrying each band's WCS params here lets a band picker group
 * composite-compatible bands (`bandGridSpec` + `gridsMatch`) without fetching
 * every per-band manifest. The `grid_hash` is a coarse Python-side grouping hint
 * only — the renderer's authoritative same-grid gate is the structural
 * `gridsMatch` over parsed WCS + exact shape — so the client never reproduces
 * that hash. We mirror the Python schema (`fitsgl/dataset.py`).
 *
 * Unlike the lenient per-pyramid manifest, the dataset manifest is a NEW schema,
 * so its `version` is required and an unknown/missing version is rejected
 * (matching the catalog format's policy: integer version, throw, no minor).
 */

import { gridsMatch, type GridSpec } from './wcs/grid-match.js';

/** The dataset-manifest schema major version this client accepts. */
export const DATASET_VERSION = 1;

/** RGB role assignment by band `name`. */
export interface DatasetRgbRoles {
  r: string;
  g: string;
  b: string;
}

/** One band: a stable key + canonical z=0 grid params (mirrors Python). */
export interface DatasetBand {
  /** Stable machine key the `default_rgb` roles reference. */
  name: string;
  /** Relative URL to that band's `manifest.json` (resolve against the dataset URL). */
  path: string;
  ctype1: string;
  ctype2: string;
  /** Native `[H, W]`. */
  shape: [number, number];
  /** `[CRPIX1, CRPIX2]`. */
  crpix: [number, number];
  /** `[CRVAL1, CRVAL2]`. */
  crval: [number, number];
  /** Derived linear transform `[cd11, cd12, cd21, cd22]` (deg/pixel). */
  cd: [number, number, number, number];
  pixel_scale_arcsec: number;
  /** Advisory grouping hint (Python-only); never the compatibility gate. */
  grid_hash: string;
}

export interface DatasetManifest {
  version: number;
  bands: DatasetBand[];
  /** Default R/G/B band names, or null when the dataset declares no default. */
  default_rgb: DatasetRgbRoles | null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown, what: string): string {
  if (typeof v !== 'string') throw new Error(`dataset: ${what} must be a string`);
  return v;
}

function asNumber(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`dataset: ${what} must be a finite number`);
  }
  return v;
}

function asPair(v: unknown, what: string): [number, number] {
  if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== 'number' || typeof v[1] !== 'number') {
    throw new Error(`dataset: ${what} must be a [number, number] pair`);
  }
  return [v[0], v[1]];
}

function asQuad(v: unknown, what: string): [number, number, number, number] {
  if (
    !Array.isArray(v) ||
    v.length !== 4 ||
    typeof v[0] !== 'number' ||
    typeof v[1] !== 'number' ||
    typeof v[2] !== 'number' ||
    typeof v[3] !== 'number'
  ) {
    throw new Error(`dataset: ${what} must be a [number, number, number, number] tuple`);
  }
  return [v[0], v[1], v[2], v[3]];
}

function validateBand(raw: unknown, idx: number): DatasetBand {
  if (!isObject(raw)) throw new Error(`dataset: band ${idx} is not an object`);
  return {
    name: asString(raw.name, `band ${idx} name`),
    path: asString(raw.path, `band ${idx} path`),
    ctype1: asString(raw.ctype1, `band ${idx} ctype1`),
    ctype2: asString(raw.ctype2, `band ${idx} ctype2`),
    shape: asPair(raw.shape, `band ${idx} shape`),
    crpix: asPair(raw.crpix, `band ${idx} crpix`),
    crval: asPair(raw.crval, `band ${idx} crval`),
    cd: asQuad(raw.cd, `band ${idx} cd`),
    pixel_scale_arcsec: asNumber(raw.pixel_scale_arcsec, `band ${idx} pixel_scale_arcsec`),
    grid_hash: asString(raw.grid_hash, `band ${idx} grid_hash`),
  };
}

/** Validate and normalize a parsed dataset manifest. Throws on structural errors. */
export function validateDataset(raw: unknown): DatasetManifest {
  if (!isObject(raw)) throw new Error('dataset: top-level value is not an object');

  // Required, checked version (new schema — a missing/unknown version signals a
  // foreign or future file, not a pre-versioned pyramid manifest).
  if (raw.version === undefined) {
    throw new Error(`dataset: missing "version" (expected ${DATASET_VERSION}).`);
  }
  if (typeof raw.version !== 'number' || !Number.isInteger(raw.version)) {
    throw new Error(`dataset: "version" must be an integer (got ${JSON.stringify(raw.version)})`);
  }
  if (raw.version !== DATASET_VERSION) {
    throw new Error(
      `dataset: unsupported version ${raw.version} (this client supports version ${DATASET_VERSION}).`,
    );
  }

  if (!Array.isArray(raw.bands)) throw new Error('dataset: "bands" must be an array');
  if (raw.bands.length === 0) throw new Error('dataset: "bands" is empty');
  const bands = raw.bands.map((b, i) => validateBand(b, i));

  let defaultRgb: DatasetRgbRoles | null = null;
  if (raw.default_rgb !== undefined && raw.default_rgb !== null) {
    if (!isObject(raw.default_rgb)) throw new Error('dataset: "default_rgb" must be an object');
    const r = asString(raw.default_rgb.r, 'default_rgb.r');
    const g = asString(raw.default_rgb.g, 'default_rgb.g');
    const b = asString(raw.default_rgb.b, 'default_rgb.b');
    const names = new Set(bands.map((band) => band.name));
    for (const [role, name] of [['r', r], ['g', g], ['b', b]] as const) {
      if (!names.has(name)) {
        throw new Error(`dataset: default_rgb.${role} references unknown band "${name}".`);
      }
    }
    defaultRgb = { r, g, b };
  }

  return { version: raw.version, bands, default_rgb: defaultRgb };
}

/** Resolve a band's relative `path` to an absolute URL against the dataset URL. */
export function resolveDatasetBandUrl(datasetUrl: string, path: string): string {
  return new URL(path, datasetUrl).toString();
}

/**
 * A band's grid identity for `gridsMatch`, reconstructed from the dataset entry
 * alone (no per-band manifest fetch). The derived `cd` is emitted as a CD-matrix
 * header, which `parseWcs` accepts; an absent RADESYS is treated as ICRS.
 */
export function bandGridSpec(band: DatasetBand): GridSpec {
  return {
    wcs: {
      CTYPE1: band.ctype1,
      CTYPE2: band.ctype2,
      CRPIX1: band.crpix[0],
      CRPIX2: band.crpix[1],
      CRVAL1: band.crval[0],
      CRVAL2: band.crval[1],
      CD1_1: band.cd[0],
      CD1_2: band.cd[1],
      CD2_1: band.cd[2],
      CD2_2: band.cd[3],
    },
    shape: band.shape,
  };
}

/**
 * Bands that share a composite-ready grid with `band` (including `band` itself),
 * via the authoritative structural `gridsMatch`. A picker uses this to offer
 * only WCS-matched bands once one channel is chosen.
 */
export function compatibleBands(band: DatasetBand, all: readonly DatasetBand[]): DatasetBand[] {
  const ref = bandGridSpec(band);
  return all.filter((b) => gridsMatch(ref, bandGridSpec(b)));
}

/** Fetch and validate a dataset manifest. */
export async function loadDataset(
  datasetUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DatasetManifest> {
  const resp = await fetchImpl(datasetUrl);
  if (!resp.ok) {
    throw new Error(
      `dataset fetch failed: ${resp.status} ${resp.statusText} for ${datasetUrl}`,
    );
  }
  const json: unknown = await resp.json();
  return validateDataset(json);
}
