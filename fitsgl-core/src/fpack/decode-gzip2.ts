/**
 * GZIP_2 tile decode: gunzip → byte-unshuffle → big-endian float32 (lossless).
 *
 * GZIP_2 is fpack's byte-shuffled GZIP: the encoder splits each float32 into its
 * 4 bytes and groups all byte-0s, then all byte-1s, etc., before gzipping (this
 * clusters similar bytes and compresses better). Reversing it is exactly
 * lossless — NaN pixels survive as their native IEEE-754 bit patterns with no
 * special handling. The three steps are: gunzip, undo the byte interleave, then
 * read the big-endian float32 values.
 */

/** Decompress a gzip member using the browser-native DecompressionStream. */
export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  // TS 5.7 types Uint8Array as Uint8Array<ArrayBufferLike>, which BodyInit rejects
  // (it could be SharedArrayBuffer-backed); ours never is, so the cast is safe.
  const body = new Response(bytes as unknown as BodyInit).body;
  if (body === null) {
    throw new Error('gunzip: could not create a readable stream from the input bytes');
  }
  const stream = body.pipeThrough(new DecompressionStream('gzip'));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Per-tile GZIP fallback decode (the tiled-image convention's lossless escape
 * hatch): gunzip → big-endian float32, NO byte shuffle. cfitsio/astropy store a
 * tile this way — raw pixels gzipped into the `GZIP_COMPRESSED_DATA` column,
 * with `COMPRESSED_DATA` left empty — whenever lossy quantization fails for
 * that one tile, which happens exactly when the tile has no quantizable signal:
 * every pixel NaN (a band's empty region on a shared grid) or constant. The
 * bytes are the tile's original IEEE-754 values in FITS (big-endian) order, so
 * the decode is bit-exact and NaN patterns pass through untouched.
 *
 * @param bytes   the tile's gzip bytes (fpack GZIP_COMPRESSED_DATA cell)
 * @param nPixels number of pixels in the tile (tile_width * tile_height)
 */
export async function decodeGzipFallbackTile(
  bytes: Uint8Array,
  nPixels: number,
): Promise<Float32Array> {
  const decompressed = await gunzip(bytes);
  if (decompressed.byteLength !== nPixels * 4) {
    throw new Error(
      `GZIP fallback decode: gunzipped ${decompressed.byteLength} bytes, expected ` +
        `${nPixels * 4} (${nPixels} float32). Non-float32 fallback tiles are not supported.`,
    );
  }
  const view = new DataView(
    decompressed.buffer,
    decompressed.byteOffset,
    decompressed.byteLength,
  );
  const floats = new Float32Array(nPixels);
  for (let i = 0; i < nPixels; i++) {
    floats[i] = view.getFloat32(i * 4, false); // false = big-endian
  }
  return floats;
}

/**
 * @param bytes   the tile's gzip bytes (fpack COMPRESSED_DATA cell)
 * @param nPixels number of pixels in the tile (tile_width * tile_height)
 */
export async function decodeGzip2Tile(bytes: Uint8Array, nPixels: number): Promise<Float32Array> {
  const B = 4; // bytes per float32
  const N = nPixels;
  const expectedBytes = N * B;

  // Step 1: gunzip.
  const decompressed = await gunzip(bytes);
  if (decompressed.byteLength !== expectedBytes) {
    throw new Error(
      `GZIP_2 decode: gunzipped ${decompressed.byteLength} bytes, expected ` +
        `${expectedBytes} (${N} float32). Tile dimensions or shuffle assumption is wrong.`,
    );
  }

  // Step 2: undo the byte shuffle.
  //   shuffled[j*N + i] holds byte j of value i  ->  unshuffled[i*B + j].
  const unshuffled = new Uint8Array(expectedBytes);
  for (let j = 0; j < B; j++) {
    const base = j * N;
    for (let i = 0; i < N; i++) {
      unshuffled[i * B + j] = decompressed[base + i]!;
    }
  }

  // Step 3: reinterpret as big-endian float32. NaN bit patterns pass through.
  const view = new DataView(unshuffled.buffer);
  const floats = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    floats[i] = view.getFloat32(i * B, false); // false = big-endian
  }
  return floats;
}
