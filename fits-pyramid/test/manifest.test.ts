import { describe, it, expect } from 'vitest';
import { validateManifest, SUPPORTED_MANIFEST_VERSION } from '../src/manifest.js';

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

describe('validateManifest — version policy (D9 + §4.2: additive, but checked)', () => {
  it('supports version 1', () => {
    expect(SUPPORTED_MANIFEST_VERSION).toBe(1);
    expect(validateManifest(rawManifest()).version).toBe(1);
  });

  it('coerces a MISSING version to 1 (every existing pyramid stays valid, D9)', () => {
    const raw = rawManifest();
    delete raw.version;
    expect(validateManifest(raw).version).toBe(1);
  });

  it('throws on an explicit unsupported major version', () => {
    expect(() => validateManifest({ ...rawManifest(), version: 2 })).toThrow(/version/i);
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
