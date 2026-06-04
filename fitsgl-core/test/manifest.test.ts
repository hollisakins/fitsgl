import { describe, it, expect } from 'vitest';
import { validateManifest, resolveSupertile, SUPPORTED_MANIFEST_VERSION } from '../src/manifest.js';

/** A minimal structurally-valid raw manifest (one z=0 level). */
function rawManifest(): Record<string, unknown> {
  return {
    version: 1,
    source_file: 'm.fits',
    native_shape: [512, 512],
    fpack_tile_size: 256,
    n_levels: 0,
    levels: [
      {
        z: 0,
        filename: 'm_z0.fits.fz',
        compression: 'GZIP_2',
        lossless: true,
        shape: [512, 512],
        fpack_tile_count: [2, 2],
        pixel_scale_arcsec: 0.03,
        wcs: {},
      },
    ],
  };
}

describe('validateManifest — version policy (D9: additive, but checked)', () => {
  it('supports versions 1 and 2', () => {
    expect(SUPPORTED_MANIFEST_VERSION).toBe(2);
    expect(validateManifest(rawManifest()).version).toBe(1);
    expect(validateManifest({ ...rawManifest(), version: 2 }).version).toBe(2);
  });

  it('coerces a MISSING version to 1 (every existing pyramid stays valid, D9)', () => {
    const raw = rawManifest();
    delete raw.version;
    expect(validateManifest(raw).version).toBe(1);
  });

  it('throws on an explicit unsupported major version', () => {
    expect(() => validateManifest({ ...rawManifest(), version: 3 })).toThrow(/version/i);
  });

  it('throws on a non-integer version', () => {
    expect(() => validateManifest({ ...rawManifest(), version: '1' })).toThrow(/version/i);
    expect(() => validateManifest({ ...rawManifest(), version: 1.5 })).toThrow(/version/i);
  });
});

describe('validateManifest — n_levels consistency', () => {
  it('derives a missing n_levels from the level count', () => {
    const raw = rawManifest();
    delete raw.n_levels;
    expect(validateManifest(raw).n_levels).toBe(0);
  });

  it('throws when n_levels disagrees with the number of levels', () => {
    expect(() => validateManifest({ ...rawManifest(), n_levels: 5 })).toThrow(/n_levels/);
  });

  it('accepts a consistent multi-level manifest', () => {
    const raw = rawManifest();
    raw.n_levels = 1;
    (raw.levels as unknown[]).push({
      z: 1,
      filename: 'm_z1.fits.fz',
      compression: 'RICE_1',
      lossless: false,
      shape: [256, 256],
      fpack_tile_count: [1, 1],
      pixel_scale_arcsec: 0.06,
      wcs: {},
    });
    expect(validateManifest(raw).n_levels).toBe(1);
  });
});

/** A v2 raw level: a 4×4-tile grid split into four disjoint 2×2 supertiles. */
const FOUR_SUPERTILES = [
  { filename: 'm_z0_0_0.fits.fz', tile_origin: [0, 0], tile_count: [2, 2] },
  { filename: 'm_z0_2_0.fits.fz', tile_origin: [2, 0], tile_count: [2, 2] },
  { filename: 'm_z0_0_2.fits.fz', tile_origin: [0, 2], tile_count: [2, 2] },
  { filename: 'm_z0_2_2.fits.fz', tile_origin: [2, 2], tile_count: [2, 2] },
];

/** A v2 raw manifest with one z=0 level whose `supertiles` is `supertiles`. */
function rawV2Manifest(supertiles: unknown): Record<string, unknown> {
  return {
    version: 2,
    source_file: 'm.fits',
    native_shape: [1024, 1024],
    fpack_tile_size: 256,
    n_levels: 0,
    levels: [
      {
        z: 0,
        compression: 'RICE_1',
        lossless: false,
        shape: [1024, 1024],
        fpack_tile_count: [4, 4], // [ny, nx]
        pixel_scale_arcsec: 0.03,
        wcs: {},
        supertiles,
      },
    ],
  };
}

describe('validateManifest — supertiles (v2) + the v1 shim', () => {
  it('synthesizes one full-grid supertile for a v1 level (filename, no supertiles)', () => {
    const raw = rawManifest();
    // [ny, nx] = [2, 3] → the shim must emit tile_count as [nx, ny] = [3, 2].
    (raw.levels as Record<string, unknown>[])[0]!.fpack_tile_count = [2, 3];
    const lvl = validateManifest(raw).levels[0]!;
    expect(lvl.supertiles).toEqual([
      { filename: 'm_z0.fits.fz', tile_origin: [0, 0], tile_count: [3, 2] },
    ]);
  });

  it('parses an explicit v2 supertiles list; filename defaults to the first', () => {
    const m = validateManifest(rawV2Manifest(FOUR_SUPERTILES));
    const lvl = m.levels[0]!;
    expect(m.version).toBe(2);
    expect(lvl.supertiles).toHaveLength(4);
    expect(lvl.filename).toBe('m_z0_0_0.fits.fz'); // defaulted from supertiles[0]
    expect(lvl.fpack_tile_count).toEqual([4, 4]); // the level's TOTAL grid is retained
  });

  it('rejects an empty supertiles array and malformed entries', () => {
    expect(() => validateManifest(rawV2Manifest([]))).toThrow(/supertiles/i);
    expect(() =>
      validateManifest(rawV2Manifest([{ tile_origin: [0, 0], tile_count: [2, 2] }])),
    ).toThrow(/filename/i);
    expect(() =>
      validateManifest(rawV2Manifest([{ filename: 'x', tile_origin: [0], tile_count: [2, 2] }])),
    ).toThrow(/tile_origin/i);
  });
});

describe('resolveSupertile', () => {
  it('maps a v1 (single-supertile) level: local == global; out-of-grid → undefined', () => {
    const lvl = validateManifest(rawManifest()).levels[0]!; // 2×2 grid, one supertile
    expect(resolveSupertile(lvl, 1, 1)).toMatchObject({ index: 0, localX: 1, localY: 1 });
    expect(resolveSupertile(lvl, 2, 0)).toBeUndefined(); // off the right edge
    expect(resolveSupertile(lvl, 0, 9)).toBeUndefined(); // off the bottom
  });

  it('routes each tile to its supertile with correct supertile-local coords', () => {
    const lvl = validateManifest(rawV2Manifest(FOUR_SUPERTILES)).levels[0]!;
    // (3,3) → bottom-right supertile (origin [2,2]) at local (1,1).
    const br = resolveSupertile(lvl, 3, 3);
    expect(br?.supertile.filename).toBe('m_z0_2_2.fits.fz');
    expect([br?.localX, br?.localY]).toEqual([1, 1]);
    // (2,1) → top-right supertile (origin [2,0]) at local (0,1).
    const tr = resolveSupertile(lvl, 2, 1);
    expect(tr?.supertile.filename).toBe('m_z0_2_0.fits.fz');
    expect([tr?.localX, tr?.localY]).toEqual([0, 1]);
    // (0,0) → top-left supertile at local (0,0).
    expect(resolveSupertile(lvl, 0, 0)).toMatchObject({ index: 0, localX: 0, localY: 0 });
    // off the level grid entirely.
    expect(resolveSupertile(lvl, 4, 0)).toBeUndefined();
  });
});
