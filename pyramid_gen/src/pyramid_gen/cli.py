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
from .init_scaffold import scan_directory, write_scaffold
from .serve import serve


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="fitsgl", description="Build and deploy FitsGL datasets.")
    sub = p.add_subparsers(dest="command", required=True)

    pi = sub.add_parser("init", help="Scan a directory of FITS mosaics and scaffold a fitsgl.toml.")
    pi.add_argument("dir", nargs="?", type=Path, default=Path("."), help="Directory to scan (default: cwd).")
    pi.add_argument("--force", action="store_true", help="Overwrite an existing fitsgl.toml.")

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
    pb.add_argument(
        "-p",
        "--processes",
        type=int,
        default=None,
        help="Worker processes for level building (default: auto, one per level capped at cpu count).",
    )
    pb.add_argument(
        "--no-verify",
        action="store_true",
        help="Skip the per-level read-back verification (a second full decode per "
        "level); use for very large mosaics where memory is the constraint.",
    )

    ps = sub.add_parser("serve", help="Serve a built dataset directory over HTTP with byte-range support.")
    ps.add_argument("dataset_dir", type=Path, help="Dataset directory to serve (e.g. dist/<name>).")
    ps.add_argument("-p", "--port", type=int, default=8000, help="Port (default 8000; 0 = pick a free port).")
    return p


def _cmd_init(args: argparse.Namespace) -> int:
    try:
        plan = scan_directory(args.dir)
        path = write_scaffold(plan, args.dir, force=args.force)
    except FileExistsError as e:
        print(f"fitsgl init: {e}", file=sys.stderr)
        return 2
    except (FileNotFoundError, ValueError) as e:
        print(f"fitsgl init: {e}", file=sys.stderr)
        return 2

    groups = plan.groups_in_order()
    print(f"scanned {args.dir}: {len(plan.bands)} band(s) in {len(groups)} grid group(s)", end="")
    print(f", {len(plan.skipped)} skipped" if plan.skipped else "")
    for gi, names in enumerate(groups):
        print(f"  grid {gi}: {', '.join(names)}")
    for skip_path, reason in plan.skipped:
        print(f"  skipped {skip_path.name}: {reason}")
    print(f"wrote {path} — edit it (set [viewer], add a catalog), then run `fitsgl build`")
    return 0


def _cmd_serve(args: argparse.Namespace) -> int:
    try:
        return serve(args.dataset_dir, port=args.port)
    except (FileNotFoundError, ValueError, OSError) as e:
        print(f"fitsgl serve: {e}", file=sys.stderr)
        return 2


def _cmd_build(args: argparse.Namespace) -> int:
    if args.processes is not None and args.processes < 1:
        print("fitsgl build: --processes must be >= 1", file=sys.stderr)
        return 2
    try:
        config = load_config(args.config)
    except (FileNotFoundError, ValueError) as e:
        print(f"fitsgl build: {e}", file=sys.stderr)
        return 2

    try:
        result = build_dataset(
            config,
            args.out,
            processes=args.processes,
            verify=not args.no_verify,
            on_progress=lambda m: print(m, flush=True),
        )
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
    if args.command == "init":
        return _cmd_init(args)
    if args.command == "build":
        return _cmd_build(args)
    if args.command == "serve":
        return _cmd_serve(args)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
