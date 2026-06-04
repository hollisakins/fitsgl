import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  colormapRGB,
  rgbToRGBA,
  resolveColormap,
  isColormapName,
  COLORMAP_NAMES,
  COLORMAP_SIZE,
  type ColormapName,
} from '../src/renderer/colormaps.js';

interface ColormapFixture {
  size: number;
  names: ColormapName[];
  colormaps: Record<ColormapName, { rgb: number[]; b64: string }>;
}

const FIX_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = JSON.parse(
  readFileSync(join(FIX_DIR, 'colormap_fixtures.json'), 'utf8'),
) as ColormapFixture;

describe('bundled colormaps — match matplotlib golden tables', () => {
  it('exposes exactly the generated palettes, in the same order', () => {
    expect(COLORMAP_NAMES).toEqual(fixture.names);
    expect(COLORMAP_SIZE).toBe(fixture.size);
  });

  it('decodes each shipped LUT to the exact matplotlib bytes', () => {
    for (const name of COLORMAP_NAMES) {
      const rgb = colormapRGB(name);
      expect(rgb.length).toBe(COLORMAP_SIZE * 3);
      const ref = fixture.colormaps[name].rgb;
      expect(rgb.length).toBe(ref.length);
      // Byte-exact: the shipped base64 must decode to the committed reference.
      const mismatch = [...rgb].findIndex((v, i) => v !== ref[i]);
      expect(mismatch).toBe(-1);
    }
  });

  it('has the expected palette endpoints (gray ramp, viridis purple->yellow)', () => {
    const gray = colormapRGB('gray');
    expect([gray[0], gray[1], gray[2]]).toEqual([0, 0, 0]);
    expect([gray[765], gray[766], gray[767]]).toEqual([255, 255, 255]);
    // viridis is the recognizable dark-purple start; assert via the fixture.
    const vir = colormapRGB('viridis');
    expect([vir[0], vir[1], vir[2]]).toEqual(fixture.colormaps.viridis.rgb.slice(0, 3));
  });

  it('caches: repeated lookups return the same decoded array instance', () => {
    expect(colormapRGB('magma')).toBe(colormapRGB('magma'));
  });
});

describe('rgbToRGBA', () => {
  it('expands N×3 RGB to N×4 opaque RGBA', () => {
    const rgba = rgbToRGBA(new Uint8Array([10, 20, 30, 40, 50, 60]));
    expect([...rgba]).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
  });

  it('converts a full bundled palette to size×4 with alpha 255', () => {
    const rgba = rgbToRGBA(colormapRGB('inferno'));
    expect(rgba.length).toBe(COLORMAP_SIZE * 4);
    for (let i = 3; i < rgba.length; i += 4) expect(rgba[i]).toBe(255);
  });

  it('rejects a LUT whose length is not a positive multiple of 3', () => {
    expect(() => rgbToRGBA(new Uint8Array([1, 2, 3, 4]))).toThrow(/multiple of 3/);
    expect(() => rgbToRGBA(new Uint8Array([]))).toThrow(/multiple of 3/);
  });
});

describe('resolveColormap', () => {
  it('resolves a bundled name to size×4 RGBA', () => {
    const { rgba, size } = resolveColormap('plasma');
    expect(size).toBe(COLORMAP_SIZE);
    expect(rgba.length).toBe(COLORMAP_SIZE * 4);
  });

  it('accepts a raw RGB LUT (D6 raw-LUT support)', () => {
    const { rgba, size } = resolveColormap(new Uint8Array([0, 0, 0, 128, 128, 128, 255, 255, 255]));
    expect(size).toBe(3);
    expect([...rgba.slice(0, 4)]).toEqual([0, 0, 0, 255]);
  });
});

describe('isColormapName', () => {
  it('is a correct guard over the bundled set', () => {
    for (const name of COLORMAP_NAMES) expect(isColormapName(name)).toBe(true);
    expect(isColormapName('jet')).toBe(false);
    expect(isColormapName('toString')).toBe(false); // not fooled by Object.prototype
  });
});
