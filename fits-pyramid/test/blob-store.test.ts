import { describe, it, expect } from 'vitest';
import {
  tileBlobKey,
  fnv1aHex,
  fingerprintManifest,
  selectDiskEvictions,
  type DiskEntry,
} from '../src/fpack/blob-store.js';
import { validateManifest, type Manifest } from '../src/manifest.js';

function makeManifest(overrides: Record<string, unknown> = {}): Manifest {
  return validateManifest({
    version: 1,
    source_file: 'mosaic.fits',
    native_shape: [512, 512],
    fpack_tile_size: 256,
    n_levels: 1,
    levels: [
      { z: 0, filename: 'z0.fits.fz', compression: 'GZIP_2', lossless: true, shape: [512, 512], fpack_tile_count: [2, 2], pixel_scale_arcsec: 0.03, wcs: {} },
      { z: 1, filename: 'z1.fits.fz', compression: 'RICE_1', lossless: false, shape: [256, 256], fpack_tile_count: [1, 1], pixel_scale_arcsec: 0.06, wcs: {} },
    ],
    ...overrides,
  });
}

describe('tileBlobKey', () => {
  it('builds a stable, namespaced key', () => {
    expect(tileBlobKey('abcd1234', 2, 5, 7)).toBe('abcd1234/2/5/7');
  });
});

describe('fnv1aHex', () => {
  it('is deterministic and 8 hex chars', () => {
    const h = fnv1aHex('hello');
    expect(h).toMatch(/^[0-9a-f]{8}$/);
    expect(fnv1aHex('hello')).toBe(h);
  });
  it('differs for different inputs', () => {
    expect(fnv1aHex('hello')).not.toBe(fnv1aHex('hellp'));
  });
});

describe('fingerprintManifest', () => {
  it('is stable for the same manifest and changes when the manifest changes', () => {
    const a = fingerprintManifest(makeManifest());
    const b = fingerprintManifest(makeManifest());
    expect(a).toBe(b);
    const c = fingerprintManifest(makeManifest({ source_file: 'other.fits' }));
    expect(c).not.toBe(a);
  });
});

describe('selectDiskEvictions', () => {
  const entries: DiskEntry[] = [
    { key: 'a', size: 100, lastAccess: 1 },
    { key: 'b', size: 100, lastAccess: 2 },
    { key: 'c', size: 100, lastAccess: 3 },
  ];

  it('evicts nothing when within budget', () => {
    expect(selectDiskEvictions(entries, 300)).toEqual([]);
    expect(selectDiskEvictions(entries, 1000)).toEqual([]);
  });

  it('evicts least-recently-accessed first until under budget', () => {
    // total 300, budget 150 -> drop until <=150: drop a (200 left), drop b (100 left) <=150 stop.
    expect(selectDiskEvictions(entries, 150)).toEqual(['a', 'b']);
  });

  it('evicts only the oldest when one removal suffices', () => {
    expect(selectDiskEvictions(entries, 250)).toEqual(['a']);
  });

  it('handles an empty store', () => {
    expect(selectDiskEvictions([], 0)).toEqual([]);
  });
});
