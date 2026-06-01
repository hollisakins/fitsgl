#!/usr/bin/env bash
#
# Build the demo's test pyramid and place it where the dev server serves it.
#
#   1. generate a synthetic FITS mosaic           (Phase 1 synthetic generator)
#   2. build its fpacked pyramid                  (Phase 1 pyramid builder)
#   3. write the result into demo/public/pyramid/ (served with Range support)
#
# After this, `npm run dev` yields a working demo.
#
# Usage:
#   scripts/build-test-pyramid.sh                 # SIZE x SIZE synthetic (default 512)
#   SIZE=8096 scripts/build-test-pyramid.sh       # larger field (non-2^n -> partial edge tiles)
#   scripts/build-test-pyramid.sh path/to/real.fits   # build from a real mosaic instead
#
# Env knobs (synthetic only):
#   SIZE     square mosaic edge length in pixels (default 512)
#   SOURCES  number of Gaussian sources (default: scales with area to keep the
#            field as populated as the 512x512 reference, ~50 per 512x512)
#   ROTATE   WCS roll in degrees (default 30) so the demo shows North-up doing
#            something visible; set ROTATE=0 for an axis-aligned field
#
# Honours $PYTHON (default: python). pyramid_gen need not be pip-installed; we
# add its src/ to PYTHONPATH.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEMO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$DEMO_DIR/.." && pwd)"
OUT_DIR="$DEMO_DIR/public/pyramid"
PY="${PYTHON:-python}"
SIZE="${SIZE:-512}"

export PYTHONPATH="$REPO_ROOT/pyramid_gen/src${PYTHONPATH:+:$PYTHONPATH}"

echo "==> output dir: $OUT_DIR"
mkdir -p "$DEMO_DIR/public"
rm -rf "$OUT_DIR" # start clean so stale level files can't linger

if [[ $# -ge 1 ]]; then
  INPUT="$1"
  if [[ ! -f "$INPUT" ]]; then
    echo "error: input mosaic not found: $INPUT" >&2
    exit 1
  fi
  echo "==> building pyramid from real mosaic: $INPUT"
  "$PY" -m pyramid_gen "$INPUT" -o "$OUT_DIR"
else
  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT
  # Three synthetic bands (M4): same TAN WCS + shape (so they share a grid and
  # composite without resampling), different RNG seeds (so each band has its own
  # source field + NaN blobs — registered colour, with rare all-NaN overlaps to
  # exercise the D8 transparent path). Named like NIRCam filters so the demo's
  # R/G/B picker is meaningful (reddest filter -> red channel).
  echo "==> generating 3x ${SIZE}x${SIZE} synthetic bands (roll ${ROTATE:-30}°)"
  "$PY" - "$WORK" "$SIZE" "${SOURCES:-}" <<'PY'
import os
import sys
from pathlib import Path
from astropy.io import fits
from pyramid_gen.synthetic import generate_synthetic_mosaic
from pyramid_gen.catalog import write_catalog_csv

work = Path(sys.argv[1])
size = int(sys.argv[2])
# Source density matched to the 512x512 reference (~50 per 512x512); SOURCES overrides.
default_sources = max(50, round(50 * (size / 512) ** 2))
sources = int(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3] else default_sources
# Roll the WCS so the client's North-up rendering visibly rotates the field.
rotation = float(os.environ.get("ROTATE", "30"))

# (band name, RNG seed). The header is seed-independent, so all three share an
# identical WCS — gridsMatch passes and the composite needs no resampling.
bands = [("f150w", 3), ("f277w", 2), ("f444w", 1)]
catalog = None
for name, seed in bands:
    image, header, cat = generate_synthetic_mosaic(
        shape=(size, size), n_sources=sources, rotation_deg=rotation, seed=seed
    )
    fits.PrimaryHDU(data=image, header=header).writeto(work / f"{name}.fits", overwrite=True)
    if catalog is None:
        catalog = cat  # overlay markers come from the first band's sources
print(f"  wrote 3 bands {size}x{size}, {sources} sources each, roll {rotation}°")
# Emit the overlay catalog here (pure, no multiprocessing in this stdin context).
write_catalog_csv(catalog, work / "catalog.csv")
PY
  echo "==> building 3 band pyramids"
  for band in f150w f277w f444w; do
    "$PY" -m pyramid_gen "$WORK/$band.fits" -o "$OUT_DIR/$band"
  done
  # Write the dataset manifest grouping the three bands (pure helper, no Pool).
  echo "==> writing dataset.json"
  "$PY" - "$OUT_DIR" <<'PY'
import sys
from pathlib import Path
from pyramid_gen.dataset import build_dataset

out = Path(sys.argv[1])
bands = [(b, out / b / "manifest.json") for b in ("f150w", "f277w", "f444w")]
ds = build_dataset(bands, out / "dataset.json", default_rgb={"r": "f444w", "g": "f277w", "b": "f150w"})
print(f"  dataset.json: {len(ds.bands)} bands, default RGB = "
      f"{ds.default_rgb['r']}/{ds.default_rgb['g']}/{ds.default_rgb['b']}")
PY
  # Serve the catalog next to the dataset so the demo overlay can fetch it.
  cp "$WORK/catalog.csv" "$OUT_DIR/catalog.csv"
  echo "==> copied catalog.csv into $OUT_DIR"
fi

echo "==> done:"
ls -la "$OUT_DIR"
echo
echo "Next: (cd $DEMO_DIR && npm install && npm run dev)"
