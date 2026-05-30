"""CLI entry point: build a FITS pyramid from one or more mosaics.

Examples
--------
    python -m pyramid_gen mosaic.fits
    python -m pyramid_gen mosaic.fits -o /tmp/out --quantize-level 16
    python -m pyramid_gen --synthetic /tmp/synth.fits   # write a test mosaic first
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .build_pyramid import (
    DEFAULT_QUANTIZE_LEVEL,
    FPACK_TILE_SIZE,
    StopAndAsk,
    build_pyramid,
)


def _write_synthetic(path: Path) -> None:
    """Write a synthetic test mosaic to ``path`` (helper for kicking the tires)."""
    from astropy.io import fits

    from .synthetic import generate_synthetic_mosaic

    image, header, _catalog = generate_synthetic_mosaic()
    fits.PrimaryHDU(data=image, header=header).writeto(path, overwrite=True)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="pyramid_gen",
        description="Build multi-resolution fpacked FITS pyramids from mosaics.",
    )
    p.add_argument(
        "inputs",
        nargs="*",
        type=Path,
        help="Input FITS mosaic file(s).",
    )
    p.add_argument(
        "-o",
        "--output-dir",
        type=Path,
        default=None,
        help="Output directory (default: <input_stem>_pyramid/ beside each input). "
        "Only valid with a single input.",
    )
    p.add_argument(
        "--tile-size",
        type=int,
        default=FPACK_TILE_SIZE,
        help=f"fpack-internal tile size (default {FPACK_TILE_SIZE}).",
    )
    p.add_argument(
        "--quantize-level",
        type=int,
        default=DEFAULT_QUANTIZE_LEVEL,
        help=f"RICE_1 quantization for z>0 levels (default {DEFAULT_QUANTIZE_LEVEL}). "
        "z=0 is always lossless.",
    )
    p.add_argument(
        "--processes",
        type=int,
        default=None,
        help="Worker process count (default: one per level, capped at cpu count).",
    )
    p.add_argument(
        "--synthetic",
        type=Path,
        metavar="PATH",
        default=None,
        help="Write a synthetic test mosaic to PATH, then build its pyramid.",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    inputs = list(args.inputs)
    if args.synthetic is not None:
        _write_synthetic(args.synthetic)
        print(f"wrote synthetic mosaic -> {args.synthetic}")
        inputs.append(args.synthetic)

    if not inputs:
        print("error: no input files (pass FITS paths or --synthetic PATH)", file=sys.stderr)
        return 2

    if args.output_dir is not None and len(inputs) > 1:
        print(
            "error: --output-dir is only valid with a single input",
            file=sys.stderr,
        )
        return 2

    rc = 0
    for inp in inputs:
        try:
            manifest = build_pyramid(
                inp,
                output_dir=args.output_dir,
                tile_size=args.tile_size,
                quantize_level=args.quantize_level,
                processes=args.processes,
            )
        except StopAndAsk as e:
            print(f"STOP: {e}", file=sys.stderr)
            rc = 3
            continue
        except Exception as e:  # noqa: BLE001 -- surface failures per-input, keep going
            print(f"error building pyramid for {inp}: {e}", file=sys.stderr)
            rc = 1
            continue

        n_files = len(manifest.levels)
        print(
            f"{inp} -> {n_files} levels (z=0..{manifest.n_levels}), "
            f"native {manifest.native_shape[0]}x{manifest.native_shape[1]}"
        )
        for lvl in manifest.levels:
            print(
                f"  z{lvl.z}: {lvl.filename}  {lvl.compression:7s} "
                f"{'lossless' if lvl.lossless else 'lossy   '}  "
                f"{lvl.shape[0]}x{lvl.shape[1]}  "
                f"{lvl.pixel_scale_arcsec:.4f}\"/px  "
                f"tiles={lvl.fpack_tile_count[0]}x{lvl.fpack_tile_count[1]}"
            )
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
