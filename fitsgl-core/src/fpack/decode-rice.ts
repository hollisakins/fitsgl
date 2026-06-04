/**
 * RICE_1 tile decode: RICE integers → dequantized float32.
 *
 * astropy compresses float tiles by quantizing to int32 (lossy) then
 * RICE-encoding the integers (lossless). To reverse, RICE-decode (Phase 2a) then
 * undo the linear quantization. The integer blank sentinel `ZBLANK` marks pixels
 * that were NaN in the original; those become JS `NaN`.
 *
 * Two quantization variants are handled:
 *   - `NO_DITHER` (or no `ZQUANTIZ`): `float = int * ZSCALE + ZZERO`.
 *   - `SUBTRACTIVE_DITHER_1/2`: the per-pixel dither offset added at quantization
 *     time is subtracted back: `float = (int - dither + 0.5) * ZSCALE + ZZERO`,
 *     with the dither drawn from the seeded fpack RNG (see `dither.ts`).
 *
 * Note on bit-exactness: astropy's C unquantizer evaluates `value * ZSCALE +
 * ZZERO` with a fused multiply-add (single rounding), which JS cannot reproduce.
 * The dithered result therefore matches astropy to within ≤1 float32 ULP. The
 * dither *index/formula* (and the NaN-mask and exact-zero handling) are exact; a
 * logic error would diverge by many ULPs, not one.
 */

import { riceDecompress } from '../rice/index.js';
import {
  NO_DITHER,
  SUBTRACTIVE_DITHER_2,
  N_RANDOM,
  DITHER_ZERO_VALUE,
  ditherRandomTable,
} from './dither.js';

/** Per-tile context needed to reverse subtractive dithering. */
export interface DitherParams {
  /** dither method: `SUBTRACTIVE_DITHER_1` or `SUBTRACTIVE_DITHER_2`. */
  method: number;
  /** the image's `ZDITHER0` seed (1..10000). */
  seed: number;
  /** the tile's 0-based row-major index (its BINTABLE row). */
  tileIndex: number;
}

/**
 * @param bytes     the tile's RICE bitstream (fpack COMPRESSED_DATA cell)
 * @param zscale    per-tile quantization scale (BINTABLE ZSCALE column)
 * @param zzero     per-tile quantization offset (BINTABLE ZZERO column)
 * @param zblank    integer blank sentinel (per-row column or ZBLANK header keyword)
 * @param nPixels   number of pixels in the tile (tile_width * tile_height)
 * @param blockSize RICE block size (ZBLOCKSIZE, default 32)
 * @param dither    subtractive-dither context; omit (or pass NO_DITHER) for the
 *                  plain `int*ZSCALE+ZZERO` path
 */
export function decodeRiceTile(
  bytes: Uint8Array,
  zscale: number,
  zzero: number,
  zblank: number,
  nPixels: number,
  blockSize: number,
  dither?: DitherParams,
): Float32Array {
  const ints = riceDecompress(bytes, nPixels, blockSize);
  const floats = new Float32Array(nPixels);

  if (dither === undefined || dither.method === NO_DITHER) {
    for (let i = 0; i < nPixels; i++) {
      const v = ints[i]!;
      floats[i] = v === zblank ? NaN : v * zscale + zzero;
    }
    return floats;
  }

  // Subtractive dithering: reverse the per-pixel dither offset using the seeded
  // fpack RNG, exactly as CFITSIO's unquantize_i4r4 does.
  const rand = ditherRandomTable();
  const dither2 = dither.method === SUBTRACTIVE_DITHER_2;

  // iseed = (tileIndex + ZDITHER0 - 1) mod N_RANDOM. With ZDITHER0 >= 1 and
  // tileIndex >= 0 this is non-negative; the guard covers a degenerate seed.
  let iseed = (dither.tileIndex + dither.seed - 1) % N_RANDOM;
  if (iseed < 0) iseed += N_RANDOM;
  let nextrand = Math.trunc(Math.fround(rand[iseed]! * 500));

  for (let i = 0; i < nPixels; i++) {
    const v = ints[i]!;
    if (v === zblank) {
      floats[i] = NaN;
    } else if (dither2 && v === DITHER_ZERO_VALUE) {
      floats[i] = 0;
    } else {
      floats[i] = (v - rand[nextrand]! + 0.5) * zscale + zzero;
    }
    // The RNG advances once per pixel — including blank/zero pixels (CFITSIO
    // increments unconditionally), so the sequence must not be skipped.
    nextrand++;
    if (nextrand === N_RANDOM) {
      iseed++;
      if (iseed === N_RANDOM) iseed = 0;
      nextrand = Math.trunc(Math.fround(rand[iseed]! * 500));
    }
  }
  return floats;
}
