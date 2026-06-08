import { describe, it, expect } from 'vitest';
import {
  COLLECTION_SCHEMA_VERSION,
  loadCollection,
  validateCollection,
} from '../src/collection.js';

/** A structurally valid raw collection (override pieces per test). */
function raw(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    collection: { name: 'survey', title: 'The Survey' },
    fields: [
      { name: 'cosmos', title: 'COSMOS', bandCount: 7, center: { ra: 150.116, dec: 2.201 } },
      { name: 'egs', title: 'EGS' },
    ],
  };
}

describe('validateCollection', () => {
  it('accepts a valid collection and narrows it', () => {
    const c = validateCollection(raw());
    expect(c.schemaVersion).toBe(COLLECTION_SCHEMA_VERSION);
    expect(c.collection).toEqual({ name: 'survey', title: 'The Survey' });
    expect(c.fields.map((f) => f.name)).toEqual(['cosmos', 'egs']);
    expect(c.fields[0]).toEqual({
      name: 'cosmos',
      title: 'COSMOS',
      bandCount: 7,
      center: { ra: 150.116, dec: 2.201 },
    });
    expect(c.fields[1]).toEqual({ name: 'egs', title: 'EGS' });
  });

  it('keeps a minimal field (name only)', () => {
    const r = raw();
    r.fields = [{ name: 'cosmos' }];
    expect(validateCollection(r).fields[0]).toEqual({ name: 'cosmos' });
  });

  it('drops an incomplete center (no ra/dec) instead of erroring', () => {
    const r = raw();
    r.fields = [{ name: 'cosmos', center: { ra: 1 } }];
    expect(validateCollection(r).fields[0].center).toBeUndefined();
  });

  it('allows a collection with no title', () => {
    const r = raw();
    r.collection = { name: 'survey' };
    expect(validateCollection(r).collection).toEqual({ name: 'survey' });
  });

  it('rejects a non-object', () => {
    expect(() => validateCollection(null)).toThrow(/not an object/);
    expect(() => validateCollection([])).toThrow(/not an object/);
  });

  it('rejects an unsupported schemaVersion', () => {
    expect(() => validateCollection({ ...raw(), schemaVersion: 2 })).toThrow(/unsupported schemaVersion/);
  });

  it('rejects a missing collection header', () => {
    const r = raw();
    delete r.collection;
    expect(() => validateCollection(r)).toThrow(/"collection" must be an object/);
  });

  it('rejects a blank collection.name', () => {
    const r = raw();
    r.collection = { name: '' };
    expect(() => validateCollection(r)).toThrow(/collection.name must be a non-empty string/);
  });

  it('rejects a non-array fields', () => {
    expect(() => validateCollection({ ...raw(), fields: {} })).toThrow(/"fields" must be an array/);
  });

  it('rejects a field without a name', () => {
    const r = raw();
    r.fields = [{ title: 'no name' }];
    expect(() => validateCollection(r)).toThrow(/fields\[0\]\.name/);
  });

  it('rejects duplicate field names', () => {
    const r = raw();
    r.fields = [{ name: 'cosmos' }, { name: 'cosmos' }];
    expect(() => validateCollection(r)).toThrow(/duplicate field name/);
  });

  it('accepts an empty fields array (a collection with no built fields yet)', () => {
    const r = raw();
    r.fields = [];
    expect(validateCollection(r).fields).toEqual([]);
  });
});

describe('loadCollection', () => {
  it('fetches, validates, and returns the collection', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify(raw()), { status: 200 })) as unknown as typeof fetch;
    const c = await loadCollection('https://x/collection.json', fakeFetch);
    expect(c).not.toBeNull();
    expect(c?.fields.map((f) => f.name)).toEqual(['cosmos', 'egs']);
  });

  it('returns null on a 404 (a field dir → caller falls back to fitsgl.json)', async () => {
    const fakeFetch = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    expect(await loadCollection('https://x/collection.json', fakeFetch)).toBeNull();
  });

  it('returns null on any non-ok status (403/500), so the field fallback is robust', async () => {
    for (const status of [403, 500]) {
      const fakeFetch = (async () => new Response('err', { status })) as unknown as typeof fetch;
      expect(await loadCollection('https://x/collection.json', fakeFetch)).toBeNull();
    }
  });

  it('throws on a present-but-invalid collection (a real but malformed root)', async () => {
    const bad = JSON.stringify({ schemaVersion: 1, collection: { name: 'x' }, fields: {} });
    const fakeFetch = (async () => new Response(bad, { status: 200 })) as unknown as typeof fetch;
    await expect(loadCollection('https://x/collection.json', fakeFetch)).rejects.toThrow(/"fields" must be an array/);
  });
});
