import { describe, it, expect } from 'vitest';
import { parseFitsHeader } from '../src/fpack/fits-header.js';
import {
  parseBinTableLayout,
  tformByteWidth,
  readDescriptor,
  readFloat64BE,
} from '../src/fpack/bintable.js';
import { readFixtureBytes, loadExpected } from './helpers.js';

const z0 = readFixtureBytes('synthetic_z0.fits.fz'); // GZIP_2
const z1 = readFixtureBytes('synthetic_z1.fits.fz'); // RICE_1
const expected = loadExpected();

function bintableHeader(file: Uint8Array) {
  return parseFitsHeader(file, parseFitsHeader(file, 0).dataStart);
}

describe('tformByteWidth', () => {
  it('sizes descriptor and fixed columns', () => {
    expect(tformByteWidth('1PB(177537)')).toEqual({ width: 8, kind: 'descriptor32' });
    expect(tformByteWidth('1QB(0)')).toEqual({ width: 16, kind: 'descriptor64' });
    expect(tformByteWidth('1D')).toEqual({ width: 8, kind: 'fixed' });
    expect(tformByteWidth('1J')).toEqual({ width: 4, kind: 'fixed' });
    expect(tformByteWidth('1E')).toEqual({ width: 4, kind: 'fixed' });
    expect(tformByteWidth('2J')).toEqual({ width: 8, kind: 'fixed' });
  });
});

describe('parseBinTableLayout', () => {
  it('GZIP_2: single COMPRESSED_DATA descriptor column, heap after the row table', () => {
    const layout = parseBinTableLayout(bintableHeader(z0));
    expect(layout.columns.map((c) => c.name)).toEqual(['COMPRESSED_DATA']);
    expect(layout.byName.has('ZSCALE')).toBe(false);
    expect(layout.byName.has('ZZERO')).toBe(false);
    expect(layout.rowBytes).toBe(8);
    expect(layout.nRows).toBe(4);
    expect(layout.theap).toBe(32); // NAXIS1 * NAXIS2
    expect(layout.dataStart).toBe(8640);
    expect(layout.heapStart).toBe(8672);
  });

  it('RICE_1: COMPRESSED_DATA + GZIP_COMPRESSED_DATA + ZSCALE + ZZERO with correct offsets', () => {
    const layout = parseBinTableLayout(bintableHeader(z1));
    expect(layout.columns.map((c) => c.name)).toEqual([
      'COMPRESSED_DATA',
      'GZIP_COMPRESSED_DATA',
      'ZSCALE',
      'ZZERO',
    ]);
    const off = Object.fromEntries(layout.columns.map((c) => [c.name, c.offset]));
    expect(off['COMPRESSED_DATA']).toBe(0);
    expect(off['GZIP_COMPRESSED_DATA']).toBe(8);
    expect(off['ZSCALE']).toBe(16);
    expect(off['ZZERO']).toBe(24);
    expect(layout.rowBytes).toBe(32);
    expect(layout.byName.get('ZSCALE')?.kind).toBe('fixed');
  });

  it('confirms ZSCALE/ZZERO presence (RICE) vs absence (GZIP_2)', () => {
    expect(parseBinTableLayout(bintableHeader(z1)).byName.has('ZSCALE')).toBe(true);
    expect(parseBinTableLayout(bintableHeader(z0)).byName.has('ZSCALE')).toBe(false);
  });
});

describe('readDescriptor / readFloat64BE on real heap descriptors', () => {
  it('GZIP_2 descriptors are sequential and sum to the heap size (PCOUNT)', () => {
    const layout = parseBinTableLayout(bintableHeader(z0));
    const cd = layout.byName.get('COMPRESSED_DATA')!;
    let expectedOffset = 0;
    let total = 0;
    for (let r = 0; r < layout.nRows; r++) {
      const d = readDescriptor(z0, layout.dataStart + r * layout.rowBytes + cd.offset, cd.kind);
      expect(d.heapOffset).toBe(expectedOffset); // tiles packed back-to-back
      expect(d.nElements).toBeGreaterThan(0);
      expectedOffset += d.nElements;
      total += d.nElements;
    }
    expect(total).toBe(layout.pcount);
  });

  it('RICE_1: descriptor + ZSCALE/ZZERO match the committed sample tile', () => {
    const layout = parseBinTableLayout(bintableHeader(z1));
    const cd = layout.byName.get('COMPRESSED_DATA')!;
    const zs = layout.byName.get('ZSCALE')!;
    const zz = layout.byName.get('ZZERO')!;
    const base = layout.dataStart; // row 0
    const desc = readDescriptor(z1, base + cd.offset, cd.kind);
    expect(desc.heapOffset).toBe(0);
    expect(desc.nElements).toBe(layout.pcount); // single tile → whole heap

    const zscale = readFloat64BE(z1, base + zs.offset);
    const zzero = readFloat64BE(z1, base + zz.offset);
    expect(zscale).toBeCloseTo(expected.sampleRiceTile.zscale, 12);
    expect(zzero).toBeCloseTo(expected.sampleRiceTile.zzero, 12);
  });
});
