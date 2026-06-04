/**
 * Public API for the standalone RICE decompression library (Phase 2a).
 *
 * RICE is a lossless integer codec: RICE-decoding the bytes produced by
 * RICE-encoding an int32 array returns the exact same int32 array. This module
 * implements only the 32-bit decode path, which is all astropy's quantized-float
 * output needs.
 */

import { rdecompInt } from './rdecomp.js';

export { BitReader } from './bitreader.js';

/**
 * Decompress a RICE_1 bitstream of 32-bit integers.
 *
 * @param compressed the compressed bytes: a 4-byte big-endian first-pixel
 *                    header followed by the MSB-first RICE bitstream, exactly as
 *                    found in an fpack `COMPRESSED_DATA` cell.
 * @param nValues    the number of int32 values the stream encodes (for an fpack
 *                    tile this is the tile area, e.g. 256*256 = 65536).
 * @param blockSize  the RICE coding block size (astropy default 32; the file's
 *                    `ZBLOCKSIZE` keyword overrides it).
 * @returns an `Int32Array` of length `nValues`.
 *
 * @throws {Error} on malformed input: a non-integer/negative `nValues`, a
 *   non-positive `blockSize`, a truncated buffer, an out-of-range FS value, or a
 *   buffer that ends before `nValues` values are produced. Trailing bytes after
 *   the last decoded value are ignored (not an error).
 */
export function riceDecompress(
  compressed: Uint8Array,
  nValues: number,
  blockSize = 32,
): Int32Array {
  if (!Number.isInteger(nValues) || nValues < 0) {
    throw new Error(`riceDecompress: nValues must be a non-negative integer, got ${nValues}`);
  }
  if (!Number.isInteger(blockSize) || blockSize <= 0) {
    throw new Error(`riceDecompress: blockSize must be a positive integer, got ${blockSize}`);
  }
  const out = new Int32Array(nValues);
  if (nValues === 0) return out;
  rdecompInt(compressed, nValues, out, blockSize);
  return out;
}
