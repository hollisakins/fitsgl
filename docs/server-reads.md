# Server-side reads: cutouts from a pyramid

The `fitsgl` Python package isn't only a *producer*. It also exposes a small,
stable **read-side** API so a server can answer cutout requests from the same
pyramid the browser renders — pick the level that matches the requested output
scale, work out which `.fits.fz` tiles cover the sky region, and range-read *just
those tiles' bytes* from R2 instead of downloading a whole file. This is what
powers CAMPFIRE's FitsGL cutout service.

This layer stops at **addressing and geometry**. It does not decode, resample, or
apply a stretch — the `.fits.fz` files are standard fpacked FITS, so astropy
reads them directly, and the consumer owns the numpy/PIL steps that turn pixels
into a FITS cutout or an RGB thumbnail.

## The three pieces

| Module | Needs astropy? | What it does |
| --- | --- | --- |
| `fitsgl.tiles` | no | Level selection (the browser's "idealZoom"), supertile resolution, tile-coverage math — pure geometry over a manifest. |
| `fitsgl.fpack_index` | no | Byte-range addressing *inside* a supertile: the exact `[start, length)` of each fpack tile's compressed bytes, parsed from the file's header with `struct`. |
| `fitsgl.cutout` | yes | `plan_cutout(...)` — ties level selection + WCS projection + tile/supertile resolution into one `CutoutPlan`. |

`tiles` and `fpack_index` are written without astropy — their level/tile/byte
math needs no WCS engine, so that code is self-contained and easy to port or
vendor. Only the sky↔pixel projection in `cutout` calls a real WCS engine.
(astropy is still a hard dependency of the `fitsgl` package as a whole — importing
the package initialises it via the producer modules — so this is about which
*computations* need a WCS engine, not about running with astropy uninstalled.)

## Planning a cutout

```python
from fitsgl import read_manifest, plan_cutout

manifest = read_manifest("path/to/band/manifest.json")  # or parse a fetched dict

plan = plan_cutout(
    manifest,
    center=(150.12, 2.20),   # (ra, dec), ICRS degrees
    fov=30.0,                # arcsec, square (or (width, height) in arcsec)
    output_size=1000,        # px, square (or (width, height) in px)
)

plan.level_index          # pyramid level chosen for this output scale
plan.output_scale_arcsec  # the scale it was selected to serve (fov / output_size)
plan.pixel_bbox           # half-open level-pixel window [x0,x1) x [y0,y1) to crop to
plan.tiles                # covering tiles, each resolved to a supertile file
plan.missing              # covering tiles that fall in a data gap (NaN-fill these)
plan.supertile_filenames()  # distinct .fits.fz files to fetch
```

**Level selection** mirrors the browser viewer: it picks the level whose
`pixel_scale_arcsec` best matches the requested output scale. Pass
`rounding="finer"` to never upsample (pick a level at least as fine as the
request, then downsample in numpy) instead of the default `"nearest"`. You can
also skip `fov`/`output_size` and pass `target_scale_arcsec=...` directly.

Each entry in `plan.tiles` is a `TileRef` carrying the global tile, the
`SupertileInfo` file that holds it, and the tile's **supertile-local**
coordinates (`local_x`, `local_y`) — the coordinates the `.fits.fz` addresses its
own tiles by.

## Reading a whole supertile (simple path)

If latency isn't critical, fetch each supertile named by the plan and let astropy
decode it — no byte addressing needed:

```python
from astropy.io import fits
from astropy.nddata import Cutout2D
from astropy.wcs import WCS
from astropy.coordinates import SkyCoord
import astropy.units as u

# fetch each plan.supertile_filenames() file, then:
with fits.open(supertile_path) as hdul:
    data, wcs = hdul[1].data, WCS(hdul[1].header)   # self-describing WCS
cut = Cutout2D(data, SkyCoord(150.12, 2.20, unit="deg"), 30 * u.arcsec, wcs=wcs)
```

Each supertile is a self-describing FITS cutout with its own shifted `CRPIX`, so
astropy's WCS reads correctly straight from the file.

## Range-reading individual tiles (latency path)

For thumbnails you don't want to pull a ~100 MB supertile to serve a 1000-px box.
`fitsgl.fpack_index.SupertileIndex` parses just the file's header + row table
(tens of KB) and hands you the byte range of any tile's compressed data:

```python
from fitsgl.fpack_index import SupertileIndex, coalesce_ranges

# `fetch(start, end_inclusive) -> bytes` is your R2/HTTP range client.
index = SupertileIndex.open(fetch)          # ~1-2 range requests, no heap read

ranges = [index.tile_byte_range(t.local_x, t.local_y) for t in tiles_in_this_file]
for r in coalesce_ranges(ranges, max_gap=4096):   # fewer round trips
    blob = fetch(r.start, r.stop - 1)
    # slice each tile back out of `blob` by (tile_range.start - r.start)
```

`tile_byte_range` returns a `ByteRange(start, length)` with a `.http_range()`
helper (`"bytes=start-end"`). `coalesce_ranges` merges adjacent tile reads into a
handful of larger ones. `index.tile_params(local_x, local_y)` additionally
reports the RICE dequantization + dither parameters (`zscale`, `zzero`, `zblank`,
`zdither0`, …) for a consumer that decodes tiles itself rather than handing whole
files to astropy.

> Range-read tile bytes are the raw compressed heap slice — decoding a single
> tile in isolation means reconstructing a minimal fpacked HDU or using a RICE
> decoder. If you're handing files to astropy, prefer the whole-supertile path
> above; reach for byte ranges when the round-trip savings matter.

## `?fast=` and lossiness

The pyramid these helpers address is the display product: `RICE_1`,
`quantize_level=8`, `SUBTRACTIVE_DITHER_2` — lossy but ~0.03% photometry-faithful.
That is the `?fast=true` path. A `?fast=false` request that needs the raw lossless
mosaic reads that mosaic directly and is out of scope for this API.
