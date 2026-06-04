/**
 * Port of CFITSIO's `fits_rdecomp` (the 32-bit / `unsigned int` RICE decoder)
 * from `ricecomp.c`, by Richard White (STScI). Variable names and the
 * three-branch block structure are kept close to the reference to aid review;
 * the only structural change is that bit I/O goes through {@link BitReader}
 * (which owns the MSB-first byte order) instead of the reference's inline `b` /
 * `nbits` accumulator. The two are bit-for-bit equivalent.
 *
 * Reference (verbatim) provenance: HEASARC/cfitsio `ricecomp.c`,
 * `fits_rdecomp(unsigned char *c, int clen, unsigned int array[], int nx, int nblock)`.
 *
 * RICE block format for the 32-bit path:
 *   - The first 4 bytes of the buffer hold the first pixel value, big-endian,
 *     uncompressed. This seeds `lastpix`.
 *   - The remaining bytes are an MSB-first bitstream of blocks of `nblock`
 *     pixels. Each block starts with a 5-bit FS field storing `fs + 1`:
 *       * field 0      -> fs = -1     : low-entropy block, all differences zero
 *                                       (every pixel equals the running value).
 *       * field fsmax+1 -> fs = fsmax : high-entropy block, each difference is
 *                                       coded directly as `bbits` (=32) raw bits.
 *       * otherwise    -> fs in 0..24 : normal Rice coding, each value is a
 *                                       unary high part + `fs` low bits.
 *   - Each decoded value is a zigzag-mapped difference from the previous pixel;
 *     the mapping and the running sum both wrap modulo 2**32 by design.
 */

import { BitReader } from './bitreader.js';

// Constants for the 32-bit (bsize == 4) path, lifted directly from the reference.
const FSBITS = 5; //  # bits used to store the FS field
const FSMAX = 25; //  maximum value of fs
const BBITS = 1 << FSBITS; //  32: bits/pixel for the high-entropy direct-coding case

/**
 * Undo the RICE zigzag mapping and differencing for one value.
 *
 * Encoder mapping (signed `d` -> unsigned): `d >= 0 -> 2d`, `d < 0 -> -2d - 1`.
 * Inverse: even `diff` -> `diff >>> 1`; odd `diff` -> `~(diff >>> 1)` (unsigned).
 * The add to `lastpix` is modulo 2**32 — the reference relies on unsigned
 * overflow here, so we mirror it with `>>> 0`.
 *
 * @param diff    the unsigned 32-bit mapped difference
 * @param lastpix the previous reconstructed pixel, as an unsigned 32-bit value
 * @returns the new reconstructed pixel, as an unsigned 32-bit value
 */
function undoMapping(diff: number, lastpix: number): number {
  const signedDiff = (diff & 1) === 0 ? diff >>> 1 : ~(diff >>> 1) >>> 0;
  return (signedDiff + lastpix) >>> 0;
}

/**
 * Decode `nx` RICE-compressed 32-bit integers into `out`.
 *
 * @param c       the compressed bytes (4-byte first-pixel header + bitstream)
 * @param nx      number of values to decode (`out.length` must be >= nx)
 * @param out     destination; written as signed int32 (the unsigned 32-bit
 *                results reinterpret losslessly into Int32Array via ToInt32)
 * @param nblock  RICE coding block size (astropy default 32)
 *
 * @throws {Error} on a malformed stream: too-short header, an out-of-range FS
 *   value, or a buffer that runs out before `nx` values are produced.
 */
export function rdecompInt(c: Uint8Array, nx: number, out: Int32Array, nblock: number): void {
  if (nx === 0) return;
  if (out.length < nx) {
    throw new Error(`rdecompInt: output array length ${out.length} is smaller than nx=${nx}`);
  }
  if (c.length < 4) {
    throw new Error(
      `rdecompInt: input buffer is ${c.length} bytes; the first 4 bytes must hold ` +
        `the uncompressed first-pixel value`,
    );
  }

  // First 4 bytes: the first pixel value, big-endian, uncompressed.
  let lastpix = ((c[0]! << 24) | (c[1]! << 16) | (c[2]! << 8) | c[3]!) >>> 0;

  // The bitstream starts immediately after the 4-byte header.
  const reader = new BitReader(c, 4);

  let i = 0;
  while (i < nx) {
    // FS field: 5 bits storing fs + 1, so fs == -1 marks a low-entropy block.
    const fs = reader.readBits(FSBITS) - 1;
    if (fs > FSMAX) {
      throw new Error(
        `rdecompInt: invalid FS value ${fs} (max ${FSMAX}) at output index ${i}; ` +
          `the bitstream is corrupt or the block size (${nblock}) is wrong`,
      );
    }

    let imax = i + nblock;
    if (imax > nx) imax = nx;

    if (fs < 0) {
      // Low-entropy: every difference in the block is zero -> a constant run.
      const value = lastpix | 0; // ToInt32 reinterpretation of the unsigned value
      for (; i < imax; i++) out[i] = value;
    } else if (fs === FSMAX) {
      // High-entropy: each value is coded directly as BBITS (=32) raw bits.
      for (; i < imax; i++) {
        const diff = reader.readBits(BBITS) >>> 0;
        lastpix = undoMapping(diff, lastpix);
        out[i] = lastpix | 0;
      }
    } else {
      // Normal Rice: unary high part (count of leading zeros) + fs low bits.
      const fsScale = 2 ** fs;
      for (; i < imax; i++) {
        const nzero = reader.readUnary();
        const low = fs === 0 ? 0 : reader.readBits(fs);
        const diff = (nzero * fsScale + low) >>> 0;
        lastpix = undoMapping(diff, lastpix);
        out[i] = lastpix | 0;
      }
    }
  }
}
