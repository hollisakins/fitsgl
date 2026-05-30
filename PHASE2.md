## Phase 2a: TypeScript RICE Decompression

```
Build Phase 2a of the FITS mosaic renderer: a standalone TypeScript RICE
decompression library, tested exhaustively against fixtures generated
from astropy.

This is the project's correctness-gating phase. RICE bugs silently
produce garbage pixels in everything downstream, so the testing
discipline here is non-negotiable.

## Background

RICE is a lossless integer compression algorithm. Given an int32 array,
RICE-encode then RICE-decode returns the EXACT same int32 array. This
phase implements only the lossless decode of integer arrays.

Important distinction: when astropy compresses float data with RICE_1,
it FIRST quantizes float to int32 (lossy), THEN RICE-encodes the
integers (lossless). The RICE step itself is lossless. Quantization
reversal happens in Phase 2b.

## Reference implementation

The canonical RICE implementation is in CFITSIO's ricecomp.c, function
fits_rdecomp_int (for 32-bit integers). Port this to TypeScript, keeping
variable names close to the reference where it aids review.

Source: https://heasarc.gsfc.nasa.gov/fitsio/c/cfitsio_latest.tar.gz
(extract and read ricecomp.c)

We implement only the 32-bit variant. 8-bit and 16-bit RICE are not
needed for astropy's quantized-float output.

## Project structure

Add to the repo:

  fits-pyramid/
    package.json
    tsconfig.json           # strict: true, no any
    vite.config.ts
    src/
      rice/
        index.ts            # public API
        rdecomp.ts          # ported from ricecomp.c
        bitreader.ts        # MSB-first bit reading from Uint8Array
    test/
      rice.test.ts
      bitreader.test.ts
      fixtures/
        rice_fixtures.json     # checked in, regeneratable
        generate_fixtures.py   # script to regenerate
  notes/
    phase2a.md

## Public API

// src/rice/index.ts
export function riceDecompress(
  compressed: Uint8Array,
  nValues: number,        // expected number of int32 values to decode
  blockSize: number = 32  // RICE block size (astropy default)
): Int32Array;

Throws on malformed input with descriptive error messages that identify
what went wrong and where.

## Fixture generation (essential)

generate_fixtures.py uses astropy to produce known-good (input,
compressed_bytes) pairs. Use an INTEGER-source array (not float) so
that astropy's RICE path is purely lossless and we test RICE in
isolation (without quantization).

1. Generate diverse int32 input arrays:
   - All zeros, all ones, all max int32, all min int32
   - Alternating 0/1, alternating large/small
   - Linear ramp, descending ramp
   - Random uniform small values, random uniform large
   - Arrays with extreme outliers
   - Lengths: 32, 33, 100, 1024, 32768, 100000

2. For each, use astropy to RICE-compress. Easiest approach: write the
   int32 array as a single-tile CompImageHDU with
   compression_type='RICE_1', tile_shape=matching the array size.
   With integer-source data, no quantization occurs. Extract the
   COMPRESSED_DATA bytes from the resulting BINTABLE.

3. Serialize to rice_fixtures.json:
   {
     "fixtures": [
       {
         "name": "all_zeros_32",
         "n_values": 32,
         "block_size": 32,
         "compressed_b64": "base64...",
         "expected_b64": "base64 of original int32 bytes (little-endian)"
       },
       ...
     ]
   }

Commit rice_fixtures.json. Tests must not depend on astropy at runtime.

## Tests (Vitest)

1. Every fixture decodes EXACTLY to expected output. No tolerance —
   RICE is lossless. Any mismatch is a bug.

2. Malformed input throws descriptive errors:
   - Truncated buffer
   - Invalid k-parameter
   - More values requested than fixture encodes

3. Edge cases handled:
   - n=0 returns empty Int32Array
   - n=1 (single value)
   - n=blockSize (exactly one block)
   - n=blockSize+1 (one full + one partial)
   - n much larger than blockSize

4. Bit reader unit tests independently:
   - Reads of 1, 7, 8, 9, 16, 17, 32 bits at various byte offsets
   - Reads spanning byte boundaries
   - Reads near end of buffer

## Implementation notes

- The RICE bitstream is MSB-first within each byte. Most common porting
  bug: wrong bit order.
- Per-block format: k-parameter (5 bits for int32) at block start, then
  per value: fundamental sequence (unary prefix terminated by 1) + k
  low-order bits. Signed-to-unsigned mapping is zigzag-style:
  n >= 0 maps to 2n; n < 0 maps to -2n-1.
- Watch for off-by-one bugs in block boundaries — second most common
  porting bug.
- Trailing bytes after nValues are decoded are OK; do not throw.

## Anti-patterns to avoid

- Do not pull in any existing JS RICE library. Few exist; those that
  do have known bugs against real fpack data.
- Do not use a generic bitstream library. Write the bit reader; ~50
  lines and you need full control over byte order.
- Tests must compare to externally-generated fixtures, not to your own
  decoder's output. Self-comparison hides systematic bugs.
- No `any` types. Strict TypeScript throughout.
- Do not move on to Phase 2b until every fixture decodes exactly.

## Stop and ask if

- A fixture decodes wrong and you've verified bit order, block
  boundaries, and k-parameter parsing.
- The astropy-produced compressed bytes have a format detail not
  documented in ricecomp.c.
- You're tempted to add tolerance to a decode test.

## Notes file

notes/phase2a.md: implementation overview, fixture inventory and what
each fixture tests, decode throughput in MB/s measured in the browser.
```

---

## Phase 2b: fpack File Parser + Tile Fetcher (with GZIP_2 path)

```
Build Phase 2b of the FITS mosaic renderer: a TypeScript library that
parses fpacked FITS files via HTTP range requests, locates tiles using
each file's BINTABLE structure, and returns decoded Float32Array tiles
ready for Phase 3. Dispatches on each file's compression type to handle
both RICE_1 (lossy, with Phase 2a) and GZIP_2 (lossless, for the
native-resolution science file).

## Goal

Given a manifest URL and a (level, tile_x, tile_y) coordinate:
1. Identify which fpack file holds the tile (one file per level)
2. Determine the file's compression type from its ZCMPTYPE keyword
3. Locate the tile's byte range from the BINTABLE row descriptors
4. HTTP range-request those bytes
5. Dispatch to the appropriate decompression path:
   - RICE_1: Phase 2a RICE decode + quantization reversal
   - GZIP_2: gunzip + byte unshuffle + big-endian to native float32
6. Return Float32Array

## Project structure

Add to the fits-pyramid package (alongside the rice/ directory from
Phase 2a):

  fits-pyramid/
    src/
      index.ts                # re-exports TilePyramid as public API
      manifest.ts             # load and type the manifest
      fpack/
        index.ts
        fits-header.ts        # parse FITS 2880-byte block headers
        bintable.ts           # parse fpack BINTABLE row descriptors
        fpack-file.ts         # FpackFile: lazy file with tile index
        tile-source.ts        # TilePyramid: high-level API
        decode-rice.ts        # RICE -> Float32 pipeline (uses Phase 2a)
        decode-gzip2.ts       # GZIP_2 -> Float32 pipeline
      worker.ts               # Web Worker entry
      lru.ts                  # small LRU implementation
    test/
      fits-header.test.ts
      bintable.test.ts
      fpack-file.test.ts
      decode-rice.test.ts
      decode-gzip2.test.ts
      tile-source.test.ts
      fixtures/
        # Small fpack files generated by Phase 1, committed for testing
        # Include BOTH a GZIP_2 file (z=0) and a RICE_1 file (z>0)
  notes/
    phase2b.md

## Public API

// src/index.ts
export class TilePyramid {
  static async load(manifestUrl: string): Promise<TilePyramid>;
  getManifest(): Manifest;

  // Coordinates are fpack-internal tile units at the given level.
  async getTile(
    level: number,
    tile_x: number,
    tile_y: number
  ): Promise<Float32Array>;

  destroy(): void;
}

Throws on network errors, parse errors, or invalid coordinates.
Returns Float32Array of length fpack_tile_size^2 (256*256 = 65536).
NaN pixels in original data appear as JS NaN in returned array.

## How fpacked FITS files are structured

Same layout for both compression types — only the bytes in the heap
differ in how they're decompressed.

  Bytes 0..N:         Primary HDU header (empty image)
  Bytes N+1..M:       BINTABLE header ("COMPRESSED_IMAGE")
  Bytes M+1..M+ROWS:  BINTABLE row data (descriptors into heap +
                      fixed-width columns like ZSCALE, ZZERO for RICE)
  Bytes M+THEAP..end: Heap area with variable-length compressed tile
                      bytes

Critical BINTABLE header keywords:
  ZNAXIS1, ZNAXIS2:   original image dimensions
  ZTILE1, ZTILE2:     fpack tile dimensions (256, 256)
  ZCMPTYPE:           'RICE_1' or 'GZIP_2' — dispatch key
  ZBITPIX:            -32 (float32) for our pipeline
  ZQUANTIZ:           quantization method (RICE files only)
  ZBLOCKSIZE:         RICE block size (RICE files only, default 32)
  NAXIS1:             BINTABLE row size in bytes
  NAXIS2:             number of rows (= number of fpack tiles)
  PCOUNT:             heap size in bytes
  THEAP:              heap offset from BINTABLE data start
                      (default: NAXIS1 * NAXIS2)
  TFIELDS, TFORM*, TTYPE*: column definitions

For RICE files, expect columns: COMPRESSED_DATA, ZSCALE, ZZERO, ZBLANK
(or ZBLANK as a header keyword).
For GZIP_2 files, expect column: COMPRESSED_DATA only (no ZSCALE/ZZERO
since GZIP_2 doesn't quantize).

Tile (tile_x, tile_y) at this level is at row index:
  tile_y * fpack_tile_count_x + tile_x

## FpackFile lifecycle

class FpackFile manages one fpack file's metadata and tile fetching:

1. **open(url)** (static async constructor):
   - Range-request first 16KB
   - Parse primary HDU header (find END, skip to next 2880 boundary)
   - Parse BINTABLE header (find END, extract Z* + N* + T* keywords)
   - Determine BINTABLE data start byte offset
   - If headers didn't fit in 16KB, fetch more
   - Read ZCMPTYPE; reject anything other than 'RICE_1' or 'GZIP_2'
   - Store dispatch type for later use

2. **loadTileIndex()** (once after open):
   - Range-request BINTABLE row data
     (NAXIS1 * NAXIS2 bytes starting at BINTABLE data offset)
   - Parse each row's descriptors:
     - COMPRESSED_DATA: (n_bytes, heap_offset)
     - For RICE_1 files: also ZSCALE (float64), ZZERO (float64),
       ZBLANK (int32 either per-row or from header)
   - Store as TileIndexEntry[] for O(1) lookup

3. **getTile(tile_x, tile_y)**:
   - Look up TileIndexEntry by row = tile_y * n_tiles_x + tile_x
   - Compute absolute byte range:
     start = bintable_data_start + theap + entry.heap_offset
     length = entry.n_bytes
   - Range-request those bytes
   - Dispatch on ZCMPTYPE:
     - RICE_1: decodeRiceTile(bytes, entry.zscale, entry.zzero, zblank)
     - GZIP_2: decodeGzip2Tile(bytes)
   - Return Float32Array

## RICE_1 decoding pipeline (decode-rice.ts)

  function decodeRiceTile(
    bytes: Uint8Array,
    zscale: number,
    zzero: number,
    zblank: number,
  ): Float32Array {
    const ints = riceDecompress(bytes, 65536, 32);  // Phase 2a
    const floats = new Float32Array(65536);
    for (let i = 0; i < 65536; i++) {
      if (ints[i] === zblank) {
        floats[i] = NaN;
      } else {
        floats[i] = ints[i] * zscale + zzero;
      }
    }
    return floats;
  }

## GZIP_2 decoding pipeline (decode-gzip2.ts)

GZIP_2 = byte-shuffle then GZIP. To reverse:
1. GZIP decompress -> shuffled byte array (length = 256*256*4 = 262144)
2. Unshuffle the bytes (reverse byte-position interleaving)
3. Reinterpret as big-endian float32; byte-swap to native

  async function decodeGzip2Tile(bytes: Uint8Array): Promise<Float32Array> {
    // Step 1: gunzip using browser-native API
    const decompressed = await gunzip(bytes);
    // Expected length: 256 * 256 * 4 = 262144 bytes
    if (decompressed.byteLength !== 262144) {
      throw new Error(`GZIP_2 decoded size ${decompressed.byteLength}, expected 262144`);
    }

    // Step 2: unshuffle. fpack byte shuffle for N values of B bytes each:
    //   shuffled[j * N + i] holds byte j of value i
    // Reverse:
    //   unshuffled[i * B + j] = shuffled[j * N + i]
    const N = 65536;  // number of values
    const B = 4;      // bytes per float32
    const unshuffled = new Uint8Array(N * B);
    for (let j = 0; j < B; j++) {
      for (let i = 0; i < N; i++) {
        unshuffled[i * B + j] = decompressed[j * N + i];
      }
    }

    // Step 3: reinterpret as big-endian float32, convert to native
    const view = new DataView(unshuffled.buffer);
    const floats = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      floats[i] = view.getFloat32(i * B, false);  // false = big-endian
    }
    return floats;
  }

GZIP decompression helper using browser-native DecompressionStream:

  async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
    const stream = new Response(bytes).body!
      .pipeThrough(new DecompressionStream('gzip'));
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

DecompressionStream is universally supported in modern browsers
(Chrome 80+, Firefox 113+, Safari 16.4+). No polyfill needed.

Note on NaN handling for GZIP_2: NaN values in the original float
array are preserved through the entire pipeline as IEEE 754 NaN bit
patterns (because GZIP_2 is exactly lossless). No special sentinel
handling needed — NaN survives natively.

## TilePyramid (high-level API)

- Loads manifest.json
- Maintains one FpackFile per pyramid level (lazy-opened on first access)
- LRU cache of decoded Float32Array tiles (default 256 entries)
- Concurrent getTile calls for the same key dedupe to one fetch+decode
- All FITS parsing, decompression, and float reconstruction in a
  Web Worker; only Float32Arrays (transferred) cross to main thread

## HTTP range requests

- fetch(url, { headers: { Range: 'bytes=START-END' }})
- Verify response.status === 206 (Partial Content)
- If 200, the server ignored Range — throw with clear error

## Tests (Vitest)

Fixtures: generate BOTH a tiny GZIP_2 fpack file (representing z=0)
AND a tiny RICE_1 fpack file (representing z=1+) by running Phase 1
on a 512x512 synthetic mosaic. Commit both. Provide a regeneration
script.

Required tests:

1. fits-header.test: parses primary and BINTABLE headers correctly,
   identifies end-of-header, finds BINTABLE start, extracts ZCMPTYPE.

2. bintable.test: parses row descriptors correctly for both RICE and
   GZIP_2 fixtures. Verifies that ZSCALE/ZZERO columns are present
   for RICE files and absent for GZIP_2 files.

3. decode-rice.test: given known input bytes (from fixture), decoded
   Float32Array matches expected with q=16 tolerance.

4. decode-gzip2.test: given known input bytes (from fixture), decoded
   Float32Array matches expected EXACTLY (lossless). This includes
   NaN pixels matching exactly.

5. fpack-file.test:
   - open() correctly reads metadata for both compression types
   - Rejects unknown ZCMPTYPE with descriptive error
   - loadTileIndex() returns correct descriptors
   - getTile() produces expected Float32Array for known fixtures
     (both RICE and GZIP_2)

6. tile-source.test (end-to-end):
   - load(manifestUrl) succeeds
   - getTile(0, x, y) returns lossless float32 from GZIP_2 file
   - getTile(1, x, y) returns approximate float32 from RICE_1 file
   - LRU cache evicts oldest; concurrent requests dedupe
   - destroy() terminates worker cleanly

7. Range request behavior:
   - 206 accepted
   - 200 throws with clear error
   - Network errors throw with clear messages

8. The GZIP_2 lossless guarantee: take the original synthetic data
   array, run end-to-end through Phase 1 GZIP_2 path and Phase 2b
   decode, assert np.array_equal-style EXACT match (NaN positions
   too).

## Anti-patterns to avoid

- Do not pull in a general FITS library.
- Do not pull in a third-party gunzip library. Use the browser-native
  DecompressionStream.
- Do not fetch whole files. Range requests only, except for the initial
  ~16KB metadata fetch.
- Do not parse BINTABLE on every getTile. Parse once, cache the index.
- Do not silently fall back to full GET on range failure.
- Do not implement compression types beyond RICE_1 and GZIP_2. Reject
  others with a clear error.
- For GZIP_2, do not skip the unshuffle step. The shuffled bytes look
  superficially like an image but produce garbage if reinterpreted
  without unshuffling.
- No `any` types.

## Stop and ask if

- A Phase 1 fixture's BINTABLE has unexpected structure (extra columns,
  GZIP_COMPRESSED_DATA fallback column alongside COMPRESSED_DATA).
- THEAP keyword is missing (default exists but worth confirming).
- A real NIRCam mosaic processed by Phase 1 differs from synthetic
  fixtures in some structural way.
- Range-request behavior on R2 differs from local dev server.
- The GZIP_2 lossless test fails — this means EITHER the byte
  unshuffle is wrong OR the byte-order handling is wrong. Both are
  classic bugs in this path.

## Notes file

notes/phase2b.md: file structure walkthrough, dispatch logic, per-path
test coverage, observed latency per tile for both compression types
(RICE and GZIP_2 tiles will have different decode costs — note both).