import { describe, it, expect } from 'vitest';
import type { Manifest, LevelInfo } from '../src/manifest.js';
import type { TilePyramid } from '../src/fpack/tile-source.js';
import {
  isRenderSource,
  normalizeSource,
  manifestGridSpec,
  geomsEqual,
  isCompatibleGrid,
} from '../src/renderer/render-source.js';
import { buildLevelGeoms } from '../src/renderer/tile-manager.js';

// A TAN WCS dict (PC+CDELT form, as the pipeline emits).
const WCS = {
  CTYPE1: 'RA---TAN',
  CTYPE2: 'DEC--TAN',
  CRPIX1: 256.5,
  CRPIX2: 256.5,
  CRVAL1: 150,
  CRVAL2: 2.2,
  PC1_1: -1,
  PC2_2: 1,
  CDELT1: 8.333e-6,
  CDELT2: 8.333e-6,
};

/** A manifest with the given native shape and per-level fpack tile counts. */
function manifest(opts: {
  shape?: [number, number];
  wcs?: Record<string, unknown>;
  tileCounts?: Array<[number, number]>;
}): Manifest {
  const shape = opts.shape ?? [512, 512];
  const wcs = opts.wcs ?? WCS;
  // One level per supplied tile count (z = 0..N), shapes halving from native.
  const counts = opts.tileCounts ?? [[2, 2], [1, 1]];
  const levels: LevelInfo[] = counts.map((tc, z) => ({
    z,
    filename: `b_z${z}.fits.fz`,
    compression: z === 0 ? 'GZIP_2' : 'RICE_1',
    lossless: z === 0,
    shape: [Math.ceil(shape[0] / 2 ** z), Math.ceil(shape[1] / 2 ** z)] as [number, number],
    fpack_tile_count: tc,
    pixel_scale_arcsec: 0.03 * 2 ** z,
    wcs: z === 0 ? wcs : {},
  }));
  return {
    version: 1,
    source_file: 'b.fits',
    native_shape: shape,
    fpack_tile_size: 256,
    n_levels: counts.length - 1,
    levels,
  };
}

/** Minimal TilePyramid-shaped stub: only getManifest() is needed by the helpers. */
function pyramidStub(m: Manifest): TilePyramid {
  return { getManifest: () => m } as unknown as TilePyramid;
}

describe('normalizeSource / isRenderSource', () => {
  const a = pyramidStub(manifest({}));
  const b = pyramidStub(manifest({}));
  const c = pyramidStub(manifest({}));

  it('a bare pyramid is single-band', () => {
    expect(isRenderSource(a)).toBe(false);
    expect(normalizeSource(a)).toEqual({ mode: 'single', pyramids: [a] });
  });

  it('a single source unwraps to one pyramid', () => {
    const s = { kind: 'single', pyramid: a } as const;
    expect(isRenderSource(s)).toBe(true);
    expect(normalizeSource(s)).toEqual({ mode: 'single', pyramids: [a] });
  });

  it('an rgb source unwraps to [r, g, b] in order', () => {
    const s = { kind: 'rgb', r: a, g: b, b: c } as const;
    expect(isRenderSource(s)).toBe(true);
    expect(normalizeSource(s)).toEqual({ mode: 'rgb', pyramids: [a, b, c] });
  });
});

describe('geomsEqual', () => {
  it('is true for identical geometries', () => {
    expect(geomsEqual(buildLevelGeoms(manifest({})), buildLevelGeoms(manifest({})))).toBe(true);
  });

  it('is false when per-level tile counts differ (same native shape, different tile size)', () => {
    // A pyramid built with a non-256 fpack tile size has the same native shape
    // but different fpack_tile_count — geomsEqual must reject it.
    const a = buildLevelGeoms(manifest({ tileCounts: [[2, 2], [1, 1]] }));
    const b = buildLevelGeoms(manifest({ tileCounts: [[4, 4], [2, 2]] }));
    expect(geomsEqual(a, b)).toBe(false);
  });

  it('is false when the level count differs', () => {
    const a = buildLevelGeoms(manifest({ tileCounts: [[2, 2], [1, 1]] }));
    const b = buildLevelGeoms(manifest({ tileCounts: [[2, 2]] }));
    expect(geomsEqual(a, b)).toBe(false);
  });
});

describe('isCompatibleGrid — the setSource gate (gridsMatch AND geomsEqual)', () => {
  const refManifest = manifest({});
  const gridSpec = manifestGridSpec(refManifest);
  const geoms = buildLevelGeoms(refManifest);

  it('accepts an identical grid', () => {
    expect(isCompatibleGrid(gridSpec, geoms, manifest({}))).toBe(true);
  });

  it('rejects a different native shape', () => {
    expect(isCompatibleGrid(gridSpec, geoms, manifest({ shape: [512, 511] }))).toBe(false);
  });

  it('rejects a half-pixel WCS offset (gridsMatch half)', () => {
    expect(isCompatibleGrid(gridSpec, geoms, manifest({ wcs: { ...WCS, CRPIX1: 257.0 } }))).toBe(
      false,
    );
  });

  it('rejects a same-shape/same-WCS pyramid built with a different tile size (geomsEqual half)', () => {
    // gridsMatch alone would ACCEPT this (identical native shape + WCS); only the
    // geomsEqual conjunction catches the divergent per-level tiling.
    const differentTiling = manifest({ tileCounts: [[4, 4], [2, 2]] });
    expect(isCompatibleGrid(gridSpec, geoms, differentTiling)).toBe(false);
  });
});
