"""``fitsgl`` — the producer CLI.

Subcommands drive the journey from FITS mosaics to a deployable dataset:
``init`` (scaffold a ``fitsgl.toml``), ``build`` (one toml → one self-contained
dataset directory), ``serve`` (preview it locally with Range support), ``deploy``
(push to Cloudflare R2 + purge the edge), and ``verify`` (assert a deployed URL
satisfies the host contract).

``python -m fitsgl`` remains the low-level single-pyramid primitive.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Callable

from .build import build_dataset, write_site
from .build_pyramid import StopAndAsk
from .config import load_config
from .demo import DEMO_RGB, build_demo
from .deploy import CloudflarePurge, DeployError, R2Target, deploy_dataset
from .env_file import load_env_file
from .deploy_plan import DeployDiff
from .init_scaffold import scan_directory, write_scaffold
from .serve import serve
from .verify import format_report, verify_deployment


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
    pb.add_argument(
        "--overwrite",
        action="store_true",
        help="Rebuild every band from scratch. By default a band already present in "
        "the output (a complete pyramid) is reused as-is and only the viewer + "
        "fitsgl.json are refreshed; pass this to force a full rebuild — e.g. after "
        "changing a [build] parameter (tile_size, quantize_level, supertile_blocks).",
    )
    site = pb.add_mutually_exclusive_group()
    site.add_argument(
        "--no-site",
        action="store_true",
        help="Skip emitting the bundled viewer (index.html + assets); write data + "
        "fitsgl.json only.",
    )
    site.add_argument(
        "--site-only",
        action="store_true",
        help="Re-emit ONLY the bundled viewer (index.html + assets) into an "
        "already-built dataset; skip the pyramid/catalog/fitsgl.json build. Fast "
        "refresh after rebuilding the viewer app (other build flags are ignored).",
    )

    pdm = sub.add_parser(
        "demo",
        help="Generate a synthetic dataset, build it (data + viewer), and optionally serve it.",
    )
    pdm.add_argument(
        "-o",
        "--out",
        type=Path,
        default=Path("dist"),
        help="Output root; the dataset is written to <out>/<name>/ (default: ./dist).",
    )
    pdm.add_argument("--name", default="demo", help="Dataset name = output subdirectory (default: demo).")
    pdm.add_argument(
        "--size", type=int, default=512, help="Square mosaic edge length in pixels (default: 512)."
    )
    pdm.add_argument("--no-catalog", action="store_true", help="Skip the overlay marker catalog.")
    pdm.add_argument(
        "--serve",
        action="store_true",
        help="Serve the dataset over HTTP once it is built (blocks until Ctrl-C).",
    )
    pdm.add_argument(
        "-p", "--port", type=int, default=8000, help="Port for --serve (default 8000; 0 = pick a free port)."
    )
    pdm.add_argument(
        "--processes",
        type=int,
        default=None,
        help="Worker processes for level building (default: auto, one per level capped at cpu count).",
    )
    pdm.add_argument(
        "--no-verify", action="store_true", help="Skip the per-level read-back verification."
    )

    ps = sub.add_parser("serve", help="Serve a built dataset directory over HTTP with byte-range support.")
    ps.add_argument("dataset_dir", type=Path, help="Dataset directory to serve (e.g. dist/<name>).")
    ps.add_argument("-p", "--port", type=int, default=8000, help="Port (default 8000; 0 = pick a free port).")

    pv = sub.add_parser("verify", help="Check a deployed dataset URL against the host contract (Range/MIME/CORS).")
    pv.add_argument("url", help="Base URL of the deployed dataset (where fitsgl.json lives).")
    pv.add_argument(
        "--origin",
        default=None,
        help="Also assert the cross-origin CORS preflight for an embedder at this site (e.g. https://campfire.example).",
    )
    pv.add_argument(
        "--strict",
        action="store_true",
        help="Promote warnings (cold edge cache, oversized objects) to failures — for CI.",
    )

    pd = sub.add_parser("deploy", help="Push a built dataset to Cloudflare R2 and purge the edge.")
    pd.add_argument("-c", "--config", type=Path, default=Path("fitsgl.toml"), help="Path to the fitsgl.toml (default: ./fitsgl.toml).")
    pd.add_argument("-o", "--out", type=Path, default=Path("dist"), help="Output root holding <dataset.name>/ (default: ./dist).")
    pd.add_argument("--dry-run", action="store_true", help="Print the upload/delete/purge plan; make no writes.")
    pd.add_argument("--no-verify", action="store_true", help="Skip the post-deploy contract check against the live URL.")
    pd.add_argument("--site-only", action="store_true", help="Push only the viewer (index.html + assets/); leave the data + its ledger entries untouched.")
    pd.add_argument("--yes", action="store_true", help="Skip the upload confirmation prompt.")
    pd.add_argument(
        "-j", "--concurrency", type=int, default=None,
        help="Parallel upload streams to R2 (default: [deploy].concurrency, else 8). Same number of "
        "uploads either way — only changed files are sent — so this just trades wall-clock for connections.",
    )
    pd.add_argument(
        "--env-file",
        type=Path,
        default=None,
        help="Read R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / CLOUDFLARE_API_TOKEN from this .env "
        "file (default: a .env next to the fitsgl.toml, if present). Real environment variables "
        "take precedence over the file.",
    )
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
    dv = plan.default_view or {"mode": "single", "band": plan.bands[0].name}
    if dv.get("mode") == "rgb":
        print(f"  default view: rgb (r={dv['r']}, g={dv['g']}, b={dv['b']})")
    else:
        print(f"  default view: single ({dv.get('band', plan.bands[0].name)})")
    print(f"wrote {path} — review it (tweak [viewer], add a catalog), then run `fitsgl build`")
    return 0


def _cmd_demo(args: argparse.Namespace) -> int:
    if args.size < 1:
        print("fitsgl demo: --size must be >= 1", file=sys.stderr)
        return 2
    if args.processes is not None and args.processes < 1:
        print("fitsgl demo: --processes must be >= 1", file=sys.stderr)
        return 2
    try:
        result = build_demo(
            args.out,
            name=args.name,
            size=args.size,
            with_catalog=not args.no_catalog,
            processes=args.processes,
            verify=not args.no_verify,
            on_progress=lambda m: print(m, flush=True),
        )
    except StopAndAsk as e:
        print(f"fitsgl demo: STOP: {e}", file=sys.stderr)
        return 3
    except (FileNotFoundError, ValueError) as e:
        print(f"fitsgl demo: {e}", file=sys.stderr)
        return 2

    print(f"built demo dataset {args.name!r} -> {result.dataset_dir}")
    print(
        f"  {len(result.band_levels)} bands, default view: rgb trilogy "
        f"({DEMO_RGB['r']}/{DEMO_RGB['g']}/{DEMO_RGB['b']})"
    )
    print(f"  config: {result.config_path}")
    if args.serve:
        return serve(result.dataset_dir, port=args.port)
    print(f"  preview it: fitsgl serve {result.dataset_dir}  (then open the printed URL)")
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

    if args.site_only:
        try:
            dataset_dir = write_site(config, args.out, on_progress=lambda m: print(m, flush=True))
        except FileNotFoundError as e:
            print(f"fitsgl build: {e}", file=sys.stderr)
            return 2
        print(f"refreshed viewer in {dataset_dir}")
        print(f"  open {dataset_dir / 'index.html'} (or run `fitsgl serve {dataset_dir}`)")
        return 0

    try:
        result = build_dataset(
            config,
            args.out,
            processes=args.processes,
            verify=not args.no_verify,
            with_site=not args.no_site,
            overwrite=args.overwrite,
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
        tag = "  (reused)" if band.name in result.reused_bands else ""
        print(f"  {band.name}: z=0..{levels}{tag}")
    if result.reused_bands:
        print(
            f"  reused {len(result.reused_bands)}/{n_bands} band(s) from a prior build "
            "(--overwrite to rebuild)"
        )
    view = config.viewer
    default = (
        f"rgb {view.r}/{view.g}/{view.b}"
        if view.mode == "rgb"
        else f"single {view.band or config.bands[0].name}"
    )
    catalog = " + catalog.csv" if config.catalog is not None else ""
    print(f"  {n_bands} band(s), default view: {default}, stretch {view.stretch or 'asinh*'}{catalog}")
    print(f"  config: {result.config_path}")
    if result.site_written:
        print(f"  viewer: open {result.dataset_dir / 'index.html'} (or run `fitsgl serve {result.dataset_dir}`)")
    return 0


def _cmd_verify(args: argparse.Namespace) -> int:
    try:
        report = verify_deployment(args.url, origin=args.origin)
    except (ValueError, OSError) as e:
        print(f"fitsgl verify: {e}", file=sys.stderr)
        return 2
    print(format_report(report, strict=args.strict), flush=True)
    return report.exit_code(strict=args.strict)


def _confirm_deploy(bucket: str) -> Callable[[DeployDiff], bool]:
    """An interactive confirm callback: prompt unless the diff is a no-op."""
    def confirm(diff: DeployDiff) -> bool:
        if diff.is_noop:
            return True  # nothing to push — no prompt
        print(
            f"About to upload {len(diff.upload)} file(s) ({diff.upload_bytes / (1024 * 1024):.1f} MB), "
            f"delete {len(diff.delete)}, purge {len(diff.purge)} from bucket {bucket!r}."
        )
        try:
            return input("Proceed? [y/N] ").strip().lower() in ("y", "yes")
        except (EOFError, KeyboardInterrupt):
            # No TTY (CI / piped stdin) or Ctrl-C → a clean decline, not a traceback.
            print("\naborted (no confirmation — re-run with --yes to deploy non-interactively)")
            return False
    return confirm


def _cmd_deploy(args: argparse.Namespace) -> int:
    try:
        config = load_config(args.config)
    except (FileNotFoundError, ValueError) as e:
        print(f"fitsgl deploy: {e}", file=sys.stderr)
        return 2
    if config.deploy is None:
        print(
            "fitsgl deploy: no [deploy] table in the config — add one with bucket/endpoint/"
            "public_url (see docs/deploy-design.md §5.3)",
            file=sys.stderr,
        )
        return 2
    if args.concurrency is not None and args.concurrency < 1:
        print("fitsgl deploy: --concurrency must be >= 1", file=sys.stderr)
        return 2
    # CLI flag wins; otherwise the [deploy].concurrency default (8 unless set in the toml).
    concurrency = args.concurrency if args.concurrency is not None else config.deploy.concurrency
    dataset_dir = args.out / config.name
    if not (dataset_dir / "fitsgl.json").is_file():
        print(f"fitsgl deploy: no built dataset at {dataset_dir} — run `fitsgl build` first", file=sys.stderr)
        return 2

    # Load credentials from a .env (next to the fitsgl.toml by default) before the
    # adapters read them from the environment. Real env vars win over the file; an
    # explicitly-requested --env-file that's missing is an error, a missing default is not.
    env_path = args.env_file if args.env_file is not None else config.config_dir / ".env"
    if args.env_file is not None and not env_path.is_file():
        print(f"fitsgl deploy: --env-file not found: {env_path}", file=sys.stderr)
        return 2
    try:
        applied = load_env_file(env_path)
    except OSError as e:
        print(f"fitsgl deploy: could not read {env_path}: {e}", file=sys.stderr)
        return 2
    if applied:
        print(f"loaded {', '.join(applied)} from {env_path}", flush=True)

    try:
        target = R2Target.from_config(config.deploy, concurrency=concurrency)
        purger = CloudflarePurge.from_config(config.deploy)
    except DeployError as e:
        print(f"fitsgl deploy: {e}", file=sys.stderr)
        return 2
    if purger is None and not args.dry_run:
        print(
            "fitsgl deploy: note: no zone_id/CLOUDFLARE_API_TOKEN → the edge purge will be skipped",
            file=sys.stderr,
        )

    confirm = None if (args.yes or args.dry_run) else _confirm_deploy(config.deploy.bucket)
    try:
        result = deploy_dataset(
            dataset_dir,
            config.deploy,
            target,
            purger=purger,
            dry_run=args.dry_run,
            run_verify=not args.no_verify,
            site_only=args.site_only,
            max_workers=concurrency,
            confirm=confirm,
            on_progress=lambda m: print(m, flush=True),
        )
    except DeployError as e:
        print(f"fitsgl deploy: {e}", file=sys.stderr)
        return 1

    if result.aborted:
        print("aborted — nothing was uploaded")
        return 0
    if result.dry_run:
        d = result.diff
        print(f"dry run: would upload {len(d.upload)} file(s), delete {len(d.delete)}, purge {len(d.purge)} URL(s)")
        return 0

    print(
        f"deployed {len(result.uploaded)} file(s), deleted {len(result.deleted)}, "
        f"purged {len(result.purged)} URL(s) → {config.deploy.public_url}"
    )
    if result.verify_report is not None:
        print(format_report(result.verify_report))
        if not result.verify_report.ok():
            print("fitsgl deploy: warning: post-deploy verify reported failures (above)", file=sys.stderr)
            return 1
    return 0


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "init":
        return _cmd_init(args)
    if args.command == "build":
        return _cmd_build(args)
    if args.command == "demo":
        return _cmd_demo(args)
    if args.command == "serve":
        return _cmd_serve(args)
    if args.command == "verify":
        return _cmd_verify(args)
    if args.command == "deploy":
        return _cmd_deploy(args)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
