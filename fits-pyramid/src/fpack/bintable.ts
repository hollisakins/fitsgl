/**
 * Parse the compressed-image BINTABLE: column layout, heap location, and the
 * per-tile variable-length descriptors.
 *
 * Layout of an fpack BINTABLE data unit:
 *   [ fixed-width row table: NAXIS1 * NAXIS2 bytes ]
 *   [ optional gap ]
 *   [ heap: PCOUNT bytes, starting THEAP bytes from the data unit start ]
 *
 * Each row holds one tile's columns. The compressed bytes live in the heap; the
 * row's `COMPRESSED_DATA` cell is a variable-length-array descriptor — for a
 * `1P` column, two big-endian int32s: (n_elements, byte_offset_into_heap). Fixed
 * columns (ZSCALE/ZZERO as `1D`) are stored inline in the row, big-endian.
 */

import type { FitsHeader } from './fits-header.js';

export type ColumnKind = 'descriptor32' | 'descriptor64' | 'fixed';

export interface ColumnDef {
  name: string;
  tform: string;
  /** byte offset of this column within a row */
  offset: number;
  /** byte width of this column within a row */
  width: number;
  kind: ColumnKind;
}

export interface BinTableLayout {
  columns: ColumnDef[];
  byName: Map<string, ColumnDef>;
  rowBytes: number; // NAXIS1
  nRows: number; // NAXIS2
  theap: number; // heap offset from data-unit start
  pcount: number; // heap size in bytes
  dataStart: number; // byte offset of the BINTABLE data unit
  heapStart: number; // dataStart + theap
}

const FIXED_SIZES: Record<string, number> = {
  L: 1,
  X: 1,
  B: 1,
  A: 1,
  I: 2,
  J: 4,
  E: 4,
  K: 8,
  D: 8,
  C: 8, // single-precision complex = 2 * 4
  M: 16, // double-precision complex = 2 * 8
};

/** Byte width and kind of a TFORM (e.g. "1PB(177537)" → 8/descriptor32, "1D" → 8/fixed). */
export function tformByteWidth(tform: string): { width: number; kind: ColumnKind } {
  const t = tform.trim();
  if (t.includes('Q')) return { width: 16, kind: 'descriptor64' }; // 2 * int64
  if (t.includes('P')) return { width: 8, kind: 'descriptor32' }; // 2 * int32
  const m = /^(\d*)\s*([A-Z])/.exec(t);
  if (m === null) throw new Error(`BINTABLE: unrecognized TFORM "${tform}"`);
  const rep = m[1] === '' ? 1 : parseInt(m[1]!, 10);
  const code = m[2]!;
  const size = FIXED_SIZES[code];
  if (size === undefined) throw new Error(`BINTABLE: unsupported TFORM code "${code}" in "${tform}"`);
  return { width: rep * size, kind: 'fixed' };
}

/** Build the BINTABLE layout from its header (uses `header.dataStart` as the data offset). */
export function parseBinTableLayout(header: FitsHeader): BinTableLayout {
  const rowBytes = header.requireInt('NAXIS1');
  const nRows = header.requireInt('NAXIS2');
  const pcount = header.getInt('PCOUNT') ?? 0;
  const tfields = header.requireInt('TFIELDS');
  const theap = header.getInt('THEAP') ?? rowBytes * nRows;
  const dataStart = header.dataStart;

  const columns: ColumnDef[] = [];
  const byName = new Map<string, ColumnDef>();
  let offset = 0;
  for (let i = 1; i <= tfields; i++) {
    const name = header.getString(`TTYPE${i}`) ?? `COL${i}`;
    const tform = header.getString(`TFORM${i}`);
    if (tform === undefined) throw new Error(`BINTABLE: missing TFORM${i}`);
    const { width, kind } = tformByteWidth(tform);
    const col: ColumnDef = { name, tform, offset, width, kind };
    columns.push(col);
    byName.set(name, col);
    offset += width;
  }
  if (offset !== rowBytes) {
    throw new Error(
      `BINTABLE: sum of column widths (${offset}) does not equal NAXIS1 (${rowBytes})`,
    );
  }

  return {
    columns,
    byName,
    rowBytes,
    nRows,
    theap,
    pcount,
    dataStart,
    heapStart: dataStart + theap,
  };
}

/** A variable-length-array descriptor: element count and byte offset into the heap. */
export interface Descriptor {
  nElements: number;
  heapOffset: number;
}

/**
 * Read a variable-length-array descriptor at absolute byte `pos` in `buf`.
 * `1P` → two big-endian int32; `1Q` → two big-endian int64 (coerced to Number).
 */
export function readDescriptor(buf: Uint8Array, pos: number, kind: ColumnKind): Descriptor {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (kind === 'descriptor64') {
    const n = Number(view.getBigInt64(pos, false));
    const off = Number(view.getBigInt64(pos + 8, false));
    return { nElements: n, heapOffset: off };
  }
  if (kind === 'descriptor32') {
    const n = view.getInt32(pos, false);
    const off = view.getInt32(pos + 4, false);
    return { nElements: n, heapOffset: off };
  }
  throw new Error(`readDescriptor: column kind "${kind}" is not a variable-length descriptor`);
}

/** Read a big-endian float64 at absolute byte `pos` in `buf`. */
export function readFloat64BE(buf: Uint8Array, pos: number): number {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return view.getFloat64(pos, false);
}
