import { describe, it, expect, vi } from 'vitest';
import { parseCatalogCSV, CATALOG_VERSION } from '../src/overlay/catalog.js';

describe('parseCatalogCSV', () => {
  it('parses ra/dec rows with style + extra (data) columns', () => {
    const csv = [
      '# fitsgl-catalog v1',
      'id,ra,dec,shape,size,color,flux',
      'src1,150.0,2.2,circle,14,#ff0000,12.5',
      'src2,150.1,2.3,box,,red,',
    ].join('\n');
    const m = parseCatalogCSV(csv);
    expect(m.length).toBe(2);
    expect(m[0]).toMatchObject({ id: 'src1', ra: 150.0, dec: 2.2, shape: 'circle', size: 14, color: '#ff0000' });
    expect(m[0].data).toEqual({ flux: 12.5 });
    expect(m[1]).toMatchObject({ id: 'src2', shape: 'box', color: 'red' });
    expect(m[1].size).toBeUndefined(); // empty cell -> unset
    expect(m[1].data).toBeUndefined(); // empty flux -> no data key
  });

  it('accepts x/y pixel rows', () => {
    const m = parseCatalogCSV('x,y\n100,50\n200,75');
    expect(m).toEqual([
      { x: 100, y: 50 },
      { x: 200, y: 75 },
    ]);
  });

  it('rejects an unsupported major version', () => {
    expect(() => parseCatalogCSV('# fitsgl-catalog v2\nra,dec\n1,2')).toThrow(/version/i);
    expect(CATALOG_VERSION).toBe(1);
  });

  it('strips a BOM and handles CRLF line endings', () => {
    const csv = '﻿ra,dec\r\n150,2.2\r\n150.5,2.3\r\n';
    const m = parseCatalogCSV(csv);
    expect(m.length).toBe(2);
    expect(m[0]).toEqual({ ra: 150, dec: 2.2 });
  });

  it('honours quoted fields containing commas', () => {
    const csv = 'ra,dec,label\n150,2.2,"NGC 1, the bright one"';
    const m = parseCatalogCSV(csv);
    expect(m.length).toBe(1);
    expect(m[0].data).toEqual({ label: 'NGC 1, the bright one' });
  });

  it('treats # and blank lines as comments', () => {
    const csv = ['# a note', '', 'ra,dec', '# mid comment', '150,2.2', ''].join('\n');
    expect(parseCatalogCSV(csv).length).toBe(1);
  });

  it('drops rows missing a complete coordinate, with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const csv = ['ra,dec', '150,', ',2.2', '150,2.2'].join('\n'); // only the last is complete
    const m = parseCatalogCSV(csv);
    expect(m.length).toBe(1);
    expect(m[0]).toEqual({ ra: 150, dec: 2.2 });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('drops rows whose column count differs from the header', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const csv = ['ra,dec', '150,2.2,extra', '151,2.3'].join('\n');
    expect(parseCatalogCSV(csv).length).toBe(1);
    warn.mockRestore();
  });

  it('treats a non-numeric coordinate as missing (dropped, not 0)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const csv = ['ra,dec', 'nan,2.2', '12:30:00,2.2'].join('\n'); // decimal degrees only
    expect(parseCatalogCSV(csv).length).toBe(0);
    warn.mockRestore();
  });

  it('maps edgewidth aliases and keeps non-numeric extras as strings', () => {
    const m = parseCatalogCSV('ra,dec,edge_width,note\n1,2,2.5,hello');
    expect(m[0].edgeWidth).toBe(2.5);
    expect(m[0].data).toEqual({ note: 'hello' });
  });

  it('treats a NaN data cell (pandas na_rep) as absent, not the string "nan"', () => {
    // Python writes a missing flux as the token `nan`; it must not surface to a
    // host as the string "nan" (the demo tooltip checks `typeof flux === number`).
    const m = parseCatalogCSV('ra,dec,flux\n150,2.2,nan\n150.1,2.3,7.5');
    expect(m.length).toBe(2);
    expect(m[0].data).toBeUndefined(); // no flux key, not { flux: 'nan' }
    expect(m[1].data).toEqual({ flux: 7.5 });
  });

  it('throws when there is no header row', () => {
    expect(() => parseCatalogCSV('# only comments\n')).toThrow(/header/i);
  });
});
