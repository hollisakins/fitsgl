# Phase 1 — FITS mosaic pyramid generator

Python pipeline that converts a FITS mosaic into N+1 independently fpacked FITS
files for HTTP range-request browser rendering. Lives in `pyramid_gen/`.

## What was built

- **`pyramid_gen/`** — installable package (`pip install -e .`), CLI entry points
  `python -m pyramid_gen` and `pyramid-gen`.
  - `build_pyramid.py` — the pipeline: read+validate input, compute level count,
    downsample, rescale WCS, write `CompImageHDU` files, verify round-trip.
  - `manifest.py` — `Manifest`/`LevelInfo` dataclasses + JSON read/write.
  - `synthetic.py` — TAN-WCS synthetic mosaic generator (Gaussian PSF sources,
    flat background + low noise, NaN blobs, source catalog).
  - `__main__.py` — argparse CLI (multiple inputs, `-o`, `--quantize-level`,
    `--synthetic` helper).

For input `mosaic.fits` it writes `mosaic_pyramid/` containing `manifest.json`
and `mosaic_z{0..N}.fits.fz`.

## Compression scheme

- **z=0**: `GZIP_2`, `quantize_level=0`, 256×256 tiles → **lossless**, the
  canonical science-distribution product.
- **z≥1**: `RICE_1`, `quantize_level=16`, 256×256 tiles → lossy visualization.

All levels share a 256×256 fpack-internal tile size (the unit of HTTP byte
ranges). `N = ceil(log2(max(dims)/256))`, clamped at 0.

## Deviations from the spec brief (deliberate, verified)

1. **GZIP_2 needs `quantize_level=0` to be lossless.** The brief said "no
   quantize_level needed; GZIP_2 doesn't quantize." That is **wrong** for this
   astropy version (7.1.0): `CompImageHDU` defaults `quantize_level=16`, which
   quantizes floats even under GZIP_2 — `np.array_equal` round-trip *fails*.
   Setting `quantize_level=0` disables quantization and the z=0 round-trip is
   bit-exact. This is the fix the brief's "stop and ask if GZIP_2 can't be made
   lossless" anticipated; the resolution was the q=0 flag, not a pipeline bug.

2. **CRPIX uses a half-pixel correction, not a plain divide.** The brief said
   "divide CRPIX by 2^z." The geometrically correct mapping for a block-average
   downsample is `CRPIX_new = CRPIX_old/f + (f-1)/(2f)`. The naive divide leaves
   a half-pixel astrometric offset (≈0.064″ for a 4× downsample at 0.03″/px);
   the correction makes downsampled pixel (0,0)'s center land exactly on the
   center of the native block it averages (verified: separation = 0.000″ vs
   0.064″ for the naive form). Test 6 asserts <1e-3″ agreement at every level.

3. **ZCMPTYPE/ZTILEn are read via `fits.open(..., disable_image_compression=True)`.**
   On a normally-opened `CompImageHDU`, `.header` is the *decompressed image*
   header and does not expose these keywords. The manifest's `compression`
   field is populated from the file's actual `ZCMPTYPE` so the hint can never
   drift from the file.

## Test coverage (29 tests, ~4s)

`test_build_pyramid.py` covers all nine spec checks: level count, per-level
compression type, ZTILE1=ZTILE2=256, **z=0 bit-exact lossless** round-trip,
z>0 within q=16 tolerance (`atol = noise_σ/4`; measured error is ~0.03σ),
per-level WCS sky-coordinate projection, NaN survival through both compression
paths (exact NaN-mask preservation), manifest↔file ZCMPTYPE agreement, and a
full CLI end-to-end run. Plus edge cases: 3-D input, multiple 2-D image HDUs,
and SIP distortion all raise `StopAndAsk`; downsample trimming and all-NaN
block reduction. `test_synthetic.py` and `test_manifest.py` cover the generator
and schema IO.

## On-disk sizes (synthetic float32, noisy)

| level | shape | type | size | ratio vs source |
|-------|-------|------|------|-----------------|
| z0 | 1024² | GZIP_2 lossless | 2.86 MB | 1.5× |
| z1 | 512²  | RICE_1 q16 | 0.32 MB | 13× |
| z2 | 256²  | RICE_1 q16 | 0.08 MB | 50× |

(4096²: z0 45 MB/1.5×, down to z4 0.07 MB/971×.) The z=0 ratio is modest because
Gaussian noise is near-incompressible losslessly; the whole 5-level 4096²
pyramid (52 MB) is *smaller* than the 67 MB source, dominated by the lossless
z=0 file. Real mosaics with more structure and NaN padding compress better.

## Performance (M-series, process-per-level)

- 1024² (3 levels): ~1.3 s
- 4096² (5 levels): ~3.2 s

Levels are built in parallel via `multiprocessing.Pool`, one process per level.
A single-level pyramid runs inline to skip Pool overhead.

## Known limitations

- **No SIP/TPV distortion support.** Detected and rejected via `StopAndAsk`
  rather than silently producing a wrong WCS under downsampling.
- **One 2-D image HDU per file.** Multiple 2-D image HDUs → `StopAndAsk`
  (ambiguous which is the science mosaic). Cubes/non-2-D → `StopAndAsk`.
- **Full native array is pickled to each worker** (process-per-level). Fine for
  the survey mosaics in scope; a shared-memory hand-off would matter only for
  very large (>10 GB) inputs.
- `block_reduce` **trims** non-tile-divisible remainders from the high-index
  edge of each axis at each level. This keeps the corner-origin WCS valid; the
  dropped strip is at most `2^z - 1` native pixels wide at level z.
- Integer-typed inputs are cast to float32 before compression.
