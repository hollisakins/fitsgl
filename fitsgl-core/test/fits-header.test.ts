import { describe, it, expect } from 'vitest';
import { parseFitsHeader, IncompleteHeaderError } from '../src/fpack/fits-header.js';
import { readFixtureBytes } from './helpers.js';

const z0 = readFixtureBytes('synthetic_z0.fits.fz'); // GZIP_2
const z1 = readFixtureBytes('synthetic_z1.fits.fz'); // RICE_1

describe('parseFitsHeader — primary + BINTABLE structure', () => {
  it('parses the primary header and finds the next HDU at the 2880 boundary', () => {
    const primary = parseFitsHeader(z0, 0);
    expect(primary.getBool('SIMPLE')).toBe(true);
    expect(primary.getInt('NAXIS')).toBe(0);
    expect(primary.dataStart).toBe(2880); // empty primary → one header block
  });

  it('parses the GZIP_2 BINTABLE header and identifies the data start', () => {
    const primary = parseFitsHeader(z0, 0);
    const bt = parseFitsHeader(z0, primary.dataStart);
    expect(bt.getString('XTENSION')).toBe('BINTABLE');
    expect(bt.getString('ZCMPTYPE')).toBe('GZIP_2');
    expect(bt.getInt('ZBITPIX')).toBe(-32);
    expect(bt.getInt('ZNAXIS1')).toBe(512);
    expect(bt.getInt('ZNAXIS2')).toBe(512);
    expect(bt.getInt('ZTILE1')).toBe(256);
    expect(bt.getInt('ZTILE2')).toBe(256);
    expect(bt.getInt('NAXIS1')).toBe(8); // one 1P descriptor per row
    expect(bt.getInt('NAXIS2')).toBe(4); // 2x2 tiles
    expect(bt.dataStart).toBe(8640); // primary block + 2 header blocks
    expect(bt.has('ZBLANK')).toBe(false); // GZIP_2 stores NaN natively
  });

  it('parses the RICE_1 BINTABLE header, including ZBLANK and ZQUANTIZ', () => {
    const primary = parseFitsHeader(z1, 0);
    const bt = parseFitsHeader(z1, primary.dataStart);
    expect(bt.getString('ZCMPTYPE')).toBe('RICE_1');
    expect(bt.getInt('ZNAXIS1')).toBe(256);
    expect(bt.getInt('NAXIS1')).toBe(32); // 2 descriptors + ZSCALE + ZZERO
    expect(bt.getInt('TFIELDS')).toBe(4);
    expect(bt.getInt('ZBLANK')).toBe(-2147483648);
    expect(bt.getString('ZQUANTIZ')).toBe('NO_DITHER');
  });

  it('exposes column keywords for both files', () => {
    const btG = parseFitsHeader(z0, parseFitsHeader(z0, 0).dataStart);
    expect(btG.getString('TTYPE1')).toBe('COMPRESSED_DATA');
    const btR = parseFitsHeader(z1, parseFitsHeader(z1, 0).dataStart);
    expect(btR.getString('TTYPE3')).toBe('ZSCALE');
    expect(btR.getString('TFORM3')).toBe('1D');
  });
});

describe('parseFitsHeader — value parsing and error handling', () => {
  it('trims trailing spaces inside quoted strings', () => {
    const bt = parseFitsHeader(z0, parseFitsHeader(z0, 0).dataStart);
    // ZCMPTYPE is stored as 'GZIP_2  ' (padded) — must come back trimmed.
    expect(bt.getString('ZCMPTYPE')).toBe('GZIP_2');
    expect(bt.getString('ZCMPTYPE')?.length).toBe(6);
  });

  it('returns undefined for absent keywords', () => {
    const primary = parseFitsHeader(z0, 0);
    expect(primary.getInt('NOPE')).toBeUndefined();
    expect(primary.getString('NOPE')).toBeUndefined();
    expect(primary.getBool('NOPE')).toBeUndefined();
  });

  it('throws IncompleteHeaderError when END is missing from the available bytes', () => {
    // The BINTABLE header occupies blocks at 2880..8640; truncate before its END.
    const truncated = z0.subarray(0, 2880 + 2880); // primary + only first BINTABLE block
    const primary = parseFitsHeader(truncated, 0); // primary is complete
    expect(() => parseFitsHeader(truncated, primary.dataStart)).toThrow(IncompleteHeaderError);
  });

  it('requireInt/requireString throw on missing keywords', () => {
    const bt = parseFitsHeader(z1, parseFitsHeader(z1, 0).dataStart);
    expect(bt.requireInt('NAXIS1')).toBe(32);
    expect(() => bt.requireInt('DOES_NOT_EXIST')).toThrow(/required integer/i);
    expect(() => bt.requireString('DOES_NOT_EXIST')).toThrow(/required string/i);
  });
});
