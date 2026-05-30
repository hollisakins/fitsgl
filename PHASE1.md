Build Phase 1 of a browser-side FITS mosaic renderer: a Python pipeline
that converts FITS mosaics into multi-resolution fpacked FITS files
suitable for HTTP range-request access from a browser client.

## Architecture

For each input mosaic, produce N+1 separate fpacked FITS files:
- z=0 (native resolution) uses GZIP_2 compression — LOSSLESS.
  This file is the canonical fpacked science distribution product.
- z=1, z=2, ... z=N use RICE_1 with quantize_level=16 — lossy, smaller,
  for browser visualization only.

All levels use the same fpack-internal tile size (256x256), which is
the unit of HTTP byte ranges the browser client will request.

## Project structure

Create at the repository root:

  pyramid_gen/
    pyproject.toml
    src/pyramid_gen/
      __init__.py
      build_pyramid.py     # main pipeline
      manifest.py          # manifest schema + IO
      synthetic.py         # synthetic test mosaic generator
      __main__.py          # CLI entry point
    tests/
      test_build_pyramid.py
      test_manifest.py
      test_synthetic.py
  notes/
    phase1.md

## Output format

For input `/path/to/mosaic.fits`, produce `/path/to/mosaic_pyramid/`:

  mosaic_pyramid/
    manifest.json
    mosaic_z0.fits.fz       # GZIP_2 LOSSLESS, native resolution
    mosaic_z1.fits.fz       # RICE_1 q=16 lossy, 2x downsampled
    mosaic_z2.fits.fz       # RICE_1 q=16 lossy, 4x downsampled
    ...
    mosaic_z{N}.fits.fz     # RICE_1 q=16 lossy, most downsampled

Each .fits.fz is an astropy CompImageHDU. Settings:

  z=0:
    compression_type='GZIP_2'      # byte-shuffled GZIP, lossless on floats
    tile_shape=(256, 256)
    # no quantize_level needed; GZIP_2 doesn't quantize

  z >= 1:
    compression_type='RICE_1'
    tile_shape=(256, 256)
    quantize_level=16              # default lossy quantization

N = ceil(log2(max(image_dims) / 256)).

## Manifest schema

manifest.json:
{
  "version": 1,
  "source_file": "mosaic.fits",
  "native_shape": [H, W],
  "fpack_tile_size": 256,
  "n_levels": N,
  "levels": [
    {
      "z": 0,
      "filename": "mosaic_z0.fits.fz",
      "compression": "GZIP_2",       // <-- new: helps client dispatch
      "lossless": true,
      "shape": [H, W],
      "fpack_tile_count": [n_tiles_y, n_tiles_x],
      "pixel_scale_arcsec": float,
      "wcs": { ...header dict... }
    },
    {
      "z": 1,
      "filename": "mosaic_z1.fits.fz",
      "compression": "RICE_1",
      "lossless": false,
      ...
    },
    ...
  ]
}

The manifest's compression hint is for client convenience. The file is
still self-describing — the client must verify the compression type by
reading the file's ZCMPTYPE keyword and trust the file over the manifest.

## Implementation notes

- Use astropy.io.fits.CompImageHDU. Do NOT shell out to the fpack CLI.
- Use astropy.nddata.block_reduce(func=np.nanmean) for downsampling.
- WCS at each level z: scale CD matrix (or CDELT) by 2^z, divide CRPIX
  by 2^z. Preserve a valid WCS in each level's file header.
- Use multiprocessing.Pool to parallelize across levels (one process per
  level — CompImageHDU writing isn't thread-safe within a level).
- NaN handling: CompImageHDU handles NaN automatically for both
  compression paths.
- After writing each file, read it back with astropy and verify pixels
  round-trip correctly:
    - z=0: np.array_equal (EXACT match, lossless guarantee)
    - z>0: np.allclose with tolerance matching q=16
  If a round-trip fails, raise — do not silently produce broken output.

## Synthetic test data

In synthetic.py:

  def generate_synthetic_mosaic(
      shape: tuple[int, int] = (1024, 1024),
      pixel_scale_arcsec: float = 0.03,
      n_sources: int = 50,
      seed: int = 42,
      nan_fraction: float = 0.01,
  ) -> tuple[np.ndarray, fits.Header, pd.DataFrame]:
      """Returns (image, header_with_TAN_WCS, source_catalog)."""

- TAN-projected WCS, RA=150.0, Dec=2.2 (COSMOS field)
- float32 array
- Gaussian PSF sources, FWHM=2.5 pixels, random positions
- Uniform background + low Gaussian noise
- ~nan_fraction NaN pixels in random connected blobs
- Catalog: DataFrame with [x, y, ra, dec, flux]

## Tests (pytest)

1. On 1024x1024 synthetic, pyramid has 3 levels (z=0, 1, 2).
2. mosaic_z0.fits.fz has ZCMPTYPE='GZIP_2'. mosaic_z1+ have
   ZCMPTYPE='RICE_1'. Verify by reading the headers.
3. All output files have ZTILE1=ZTILE2=256.
4. z=0 file round-trips LOSSLESSLY: read back the file with astropy,
   assert np.array_equal with the source pixels (modulo NaN handling).
   This is the science-distribution lossless guarantee.
5. z>0 files round-trip within q=16 tolerance.
6. WCS at each level correctly projects to expected sky coords.
7. NaN pixels in input survive as NaN through both compression paths.
8. Manifest's `compression` field matches each file's actual ZCMPTYPE.
9. CLI invocation produces all expected files and a valid manifest.

Run pytest after each significant change. Do not weaken tests if they
fail — fix the underlying code. The z=0 lossless test in particular
must pass exactly; tolerance there indicates a real bug.

## Anti-patterns to avoid

- Do not shell out to the `fpack` CLI tool.
- Do not use astropy's default tile_shape. Tile_shape MUST be explicitly
  (256, 256).
- Do not use lossy compression at z=0. That file is the science product.
- Do not precompute byte offsets in the manifest. Self-describing files.
- No heavy deps. astropy + numpy + multiprocessing only.

## Stop and ask if

- Input has multiple image HDUs and it's unclear which to tile.
- WCS contains SIP/TPV distortion polynomials.
- Image is not 2D.
- GZIP_2 round-trip can't be made exactly lossless. (It should be —
  GZIP_2 is byte-shuffled GZIP, lossless by construction. If it isn't,
  something is wrong with the pipeline or the astropy version.)

## Notes file

notes/phase1.md: what was built, test coverage, on-disk sizes
(GZIP_2 z=0 vs source; RICE_1 z>0 vs source), perf on synthetic
input, known limitations.