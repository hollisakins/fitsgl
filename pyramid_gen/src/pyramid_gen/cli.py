"""``fitsgl`` — the producer CLI.

Subcommands drive the journey from FITS mosaics to a deployable dataset. The
first (and currently only) command is ``build``: one ``fitsgl.toml`` in, one
self-contained dataset directory out. ``init``/``serve``/``deploy`` are planned.

``python -m pyramid_gen`` remains the low-level single-pyramid primitive.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .build import build_dataset
from .build_pyramid import StopAndAsk
from .config import load_config


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="fitsgl", description="Build and deploy FitsGL datasets.")
    sub = p.add_subparsers(dest="command", required=True)

    pb = sub.add_parser("build", help="Build a dataset directory from a fitsgl.toml.")
    pb.add_argument(
        "-c",
        "--config",
        type=Path,
        default=Path("fitsgl.toml"),
        help="Path to the fitsgl.toml (default: ./fitsgl.toml).",
    )
    pb.add_argument(
        "-o",
        "--out",
        type=Path,
        default=Path("dist"),
        help="Output root; the dataset is written to <out>/<dataset.name>/ (default: ./dist).",
    )
    return p


def _cmd_build(args: argparse.Namespace) -> int:
    try:
        config = load_config(args.config)
    except (FileNotFoundError, ValueError) as e:
        print(f"fitsgl build: {e}", file=sys.stderr)
        return 2

    try:
        result = build_dataset(config, args.out)
    except StopAndAsk as e:
        print(f"fitsgl build: STOP: {e}", file=sys.stderr)
        return 3
    except (FileNotFoundError, ValueError) as e:
        print(f"fitsgl build: {e}", file=sys.stderr)
        return 2

    n_bands = len(config.bands)
    print(f"built dataset {config.name!r} -> {result.dataset_dir}")
    for band in config.bands:
        levels = result.band_levels.get(band.name, 0)
        print(f"  {band.name}: z=0..{levels}")
    view = config.viewer
    default = (
        f"rgb {view.r}/{view.g}/{view.b}"
        if view.mode == "rgb"
        else f"single {view.band or config.bands[0].name}"
    )
    catalog = " + catalog.csv" if config.catalog is not None else ""
    print(f"  {n_bands} band(s), default view: {default}, stretch {view.stretch or 'asinh*'}{catalog}")
    print(f"  config: {result.config_path}")
    return 0


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "build":
        return _cmd_build(args)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
