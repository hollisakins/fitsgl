/**
 * Collection (the multi-field landing page contract) — the `collection.json` a
 * `fitsgl index` emits at the deploy ROOT (bucket prefix ""), listing every field
 * deployed under the same bucket. It is the sibling of `FitsglConfig`: where
 * `fitsgl.json` describes ONE field's dataset, `collection.json` is the index OVER
 * fields, each card linking into that field's own viewer at `<name>/`.
 *
 * The viewer's landing page probes `collection.json` first; finding it (the root)
 * renders the picker, otherwise it falls back to `loadFitsglConfig('fitsgl.json')`
 * (a field). They never coexist in one directory, so first-match wins.
 *
 * Pure (no GL/DOM): validation unit-tests under Node, mirroring `fitsgl-config`.
 */

/** The collection schema major version this client accepts (independent of
 *  `FITSGL_SCHEMA_VERSION` — the field config has its own). */
export const COLLECTION_SCHEMA_VERSION = 1;

/** One field card in the landing page. */
export interface CollectionField {
  /** URL slug == the field's deploy prefix; the card links to `<name>/`. */
  name: string;
  /** Display title for the card; defaults to `name`. */
  title?: string;
  /** Band count, for the card subtitle (producer-precomputed; no fetch needed). */
  bandCount?: number;
  /** Optional field center for a position chip. Decimal degrees, ICRS. */
  center?: { ra: number; dec: number };
}

export interface Collection {
  schemaVersion: number;
  /** Landing-page header identity (name + optional human title). */
  collection: { name: string; title?: string };
  fields: CollectionField[];
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validate + narrow a parsed `collection.json` body. Throws a pointed Error on any
 * schema problem (mirrors `validateFitsglConfig`). Unknown extra keys are ignored
 * (forward-compatible); only `name` is required per field.
 */
export function validateCollection(raw: unknown): Collection {
  if (!isObj(raw)) throw new Error('collection: top-level value is not an object');
  if (raw.schemaVersion !== COLLECTION_SCHEMA_VERSION)
    throw new Error(
      `collection: unsupported schemaVersion ${JSON.stringify(raw.schemaVersion)} (expected ${COLLECTION_SCHEMA_VERSION})`,
    );

  const c = raw.collection;
  if (!isObj(c)) throw new Error('collection: "collection" must be an object');
  if (typeof c.name !== 'string' || c.name === '')
    throw new Error('collection: collection.name must be a non-empty string');
  const header: { name: string; title?: string } = { name: c.name };
  if (typeof c.title === 'string') header.title = c.title;

  if (!Array.isArray(raw.fields)) throw new Error('collection: "fields" must be an array');
  const seen = new Set<string>();
  const fields = raw.fields.map((f, i): CollectionField => {
    if (!isObj(f)) throw new Error(`collection: fields[${i}] is not an object`);
    if (typeof f.name !== 'string' || f.name === '')
      throw new Error(`collection: fields[${i}].name must be a non-empty string`);
    if (seen.has(f.name)) throw new Error(`collection: duplicate field name "${f.name}"`);
    seen.add(f.name);
    const out: CollectionField = { name: f.name };
    if (typeof f.title === 'string') out.title = f.title;
    if (typeof f.bandCount === 'number' && Number.isFinite(f.bandCount)) out.bandCount = f.bandCount;
    if (isObj(f.center) && typeof f.center.ra === 'number' && typeof f.center.dec === 'number')
      out.center = { ra: f.center.ra, dec: f.center.dec };
    return out;
  });

  return { schemaVersion: COLLECTION_SCHEMA_VERSION, collection: header, fields };
}

/**
 * Fetch + validate a `collection.json`, or `null` when there isn't one here.
 *
 * Returns `null` on ANY non-ok response (404 at a field dir is the common case, but
 * also 403/500/etc — so the landing page robustly falls back to `fitsgl.json` no
 * matter how a server reports a missing file). A response that IS present (200) but
 * fails to parse/validate THROWS, so a genuinely malformed collection root surfaces
 * its real schema error instead of being masked by a downstream `fitsgl.json` 404.
 */
export async function loadCollection(url: string, fetchImpl: typeof fetch = fetch): Promise<Collection | null> {
  const resp = await fetchImpl(url);
  if (!resp.ok) return null; // not a collection root here → caller falls back to fitsgl.json
  const json: unknown = await resp.json();
  return validateCollection(json);
}
