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
  INPUT="$WORK/synthetic.fits"
  echo "==> generating ${SIZE}x${SIZE} synthetic mosaic (roll ${ROTATE:-30}°)"
  "$PY" - "$INPUT" "$SIZE" "${SOURCES:-}" <<'PY'
import os
import sys
from pathlib import Path
from astropy.io import fits
from pyramid_gen.synthetic import generate_synthetic_mosaic
from pyramid_gen.catalog import write_catalog_csv

out = sys.argv[1]
size = int(sys.argv[2])
# Gaussian sources on a flat background + low noise, with a few NaN blobs.
# Keep source density matched to the 512x512 reference (~50 per 512x512) so a
# larger field doesn't become 50 needles in a haystack; SOURCES overrides it.
default_sources = max(50, round(50 * (size / 512) ** 2))
sources = int(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3] else default_sources
# Roll the WCS so the client's North-up rendering visibly rotates the field.
rotation = float(os.environ.get("ROTATE", "30"))
image, header, catalog = generate_synthetic_mosaic(
    shape=(size, size), n_sources=sources, rotation_deg=rotation
)
fits.PrimaryHDU(data=image, header=header).writeto(out, overwrite=True)
# Emit the overlay catalog here (no multiprocessing in this stdin context, so it
# is safe) for the demo to show markers; the pyramid build runs separately below.
write_catalog_csv(catalog, Path(out).with_name("catalog.csv"))
print(f"  wrote {image.shape[1]}x{image.shape[0]} {image.dtype} mosaic, {sources} sources, roll {rotation}°")
PY
  echo "==> building pyramid"
  "$PY" -m pyramid_gen "$INPUT" -o "$OUT_DIR"
  # Serve the catalog next to the manifest so the demo overlay can fetch it.
  cp "$(dirname "$INPUT")/catalog.csv" "$OUT_DIR/catalog.csv"
  echo "==> copied catalog.csv into $OUT_DIR"
fi

echo "==> done:"
ls -la "$OUT_DIR"
echo
echo "Next: (cd $DEMO_DIR && npm install && npm run dev)"
