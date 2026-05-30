/**
 * RICE_1 tile decode: RICE integers → dequantized float32.
 *
 * astropy compresses float tiles by quantizing to int32 (lossy) then
 * RICE-encoding the integers (lossless). To reverse, RICE-decode (Phase 2a) then
 * undo the linear quantization: `float = int * ZSCALE + ZZERO`. The integer
 * blank sentinel `ZBLANK` marks pixels that were NaN in the original; those
 * become JS `NaN`.
 */

import { riceDecompress } from '../rice/index.js';

/**
 * @param bytes     the tile's RICE bitstream (fpack COMPRESSED_DATA cell)
 * @param zscale    per-tile quantization scale (BINTABLE ZSCALE column)
 * @param zzero     per-tile quantization offset (BINTABLE ZZERO column)
 * @param zblank    integer blank sentinel (per-row column or ZBLANK header keyword)
 * @param nPixels   number of pixels in the tile (tile_width * tile_height)
 * @param blockSize RICE block size (ZBLOCKSIZE, default 32)
 */
export function decodeRiceTile(
  bytes: Uint8Array,
  zscale: number,
  zzero: number,
  zblank: number,
  nPixels: number,
  blockSize: number,
): Float32Array {
  const ints = riceDecompress(bytes, nPixels, blockSize);
  const floats = new Float32Array(nPixels);
  for (let i = 0; i < nPixels; i++) {
    const v = ints[i]!;
    floats[i] = v === zblank ? NaN : v * zscale + zzero;
  }
  return floats;
}
