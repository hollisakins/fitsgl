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
from .collection import emit_collection
from .config import DeployConfig, load_config, read_dataset_name
from .demo import DEMO_RGB, build_demo
from .deploy import CloudflarePurge, DeployError, R2Target, deploy_collection_root, deploy_dataset
from .env_file import load_env_file
from .deploy_plan import DeployDiff
from .init_scaffold import scan_directory, write_scaffold
from .serve import serve
from .verify import format_report, verify_deployment
from .workspace import (
    FieldRef,
    WorkspaceConfig,
    field_deploy_config,
    field_prefix,
    load_workspace,
    select_fields,
    validate_workspace_fields,
)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="fitsgl", description="Build and deploy FitsGL datasets.")
    sub = p.add_subparsers(dest="command", required=True)

    pi = sub.add_parser("init", help="Scan a directory of FITS mosaics and scaffold a fitsgl.toml.")
    pi.add_argument("dir", nargs="?", type=Path, default=Path("."), help="Directory to scan (default: cwd).")
    pi.add_argument("--force", action="store_true", help="Overwrite an existing fitsgl.toml.")

    pb = sub.add_parser("build", help="Build a dataset directory from a fitsgl.toml (or a whole workspace).")
    bsrc = pb.add_mutually_exclusive_group()
    bsrc.add_argument(
        "-c",
        "--config",
        type=Path,
        default=Path("fitsgl.toml"),
        help="Path to a single fitsgl.toml (default: ./fitsgl.toml). Mutually exclusive with -w.",
    )
    bsrc.add_argument(
        "-w",
        "--workspace",
        type=Path,
        default=None,
        help="Path to a fitsgl.workspace.toml; builds every [[field]] in it (a shared [deploy] "
        "block + references to per-field fitsgl.toml). Use --field to subset.",
    )
    pb.add_argument(
        "--field",
        action="append",
        default=None,
        metavar="NAME",
        help="With -w: build only this field (its prefix; repeatable). Default: all fields.",
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

    pd = sub.add_parser("deploy", help="Push a built dataset (or a whole workspace) to Cloudflare R2 and purge the edge.")
    dsrc = pd.add_mutually_exclusive_group()
    dsrc.add_argument("-c", "--config", type=Path, default=Path("fitsgl.toml"), help="Path to a single fitsgl.toml (default: ./fitsgl.toml). Mutually exclusive with -w.")
    dsrc.add_argument(
        "-w", "--workspace", type=Path, default=None,
        help="Path to a fitsgl.workspace.toml; deploys every [[field]] (one shared [deploy], one "
        "bucket, one prefix per field) plus the collection landing page. Use --field to subset.",
    )
    pd.add_argument("--field", action="append", default=None, metavar="NAME", help="With -w: deploy only this field (its prefix; repeatable). Default: all fields.")
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

    px = sub.add_parser(
        "index",
        help="Emit the collection landing page (collection.json + picker viewer) for a workspace.",
    )
    px.add_argument("-w", "--workspace", type=Path, default=Path("fitsgl.workspace.toml"), help="Path to the fitsgl.workspace.toml (default: ./fitsgl.workspace.toml).")
    px.add_argument("-o", "--out", type=Path, default=Path("dist"), help="Output root holding the built field dirs (default: ./dist).")
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


def _load_workspace_validated(path: Path) -> tuple[WorkspaceConfig, list[str]]:
    """Load + cross-validate a workspace; return it with each field's peeked dataset
    name. Peeking ``[dataset].name`` (not a full ``load_config``) means validation
    never stats any band's FITS input, so a subset build/deploy needs only the
    selected fields' inputs. Raises FileNotFoundError / ValueError on any problem."""
    ws = load_workspace(path)
    names = [read_dataset_name(ref.config_path) for ref in ws.fields]
    validate_workspace_fields(ws, names)
    return ws, names


def _cmd_build_workspace(args: argparse.Namespace) -> int:
    if args.processes is not None and args.processes < 1:
        print("fitsgl build: --processes must be >= 1", file=sys.stderr)
        return 2
    try:
        ws, names = _load_workspace_validated(args.workspace)
        selected = select_fields(ws, args.field, names)
    except (FileNotFoundError, ValueError) as e:
        print(f"fitsgl build: {e}", file=sys.stderr)
        return 2

    n = len(selected)
    ok: list[str] = []
    failures: list[tuple[str, str]] = []
    for i, (ref, dsname) in enumerate(selected, 1):
        print(f"\n[{i}/{n}] field {dsname}  ({ref.config_path})", flush=True)
        try:
            child = load_config(ref.config_path)
        except (FileNotFoundError, ValueError) as e:
            print(f"  fitsgl build: {dsname}: {e}", file=sys.stderr)
            failures.append((dsname, str(e)))
            continue
        if child.deploy is not None and ws.deploy is not None:
            print(
                f"  note: {ref.config_path.name} has its own [deploy]; the workspace [deploy] "
                "(shared bucket + derived public_url) overrides it under -w.",
                file=sys.stderr,
            )
        try:
            if args.site_only:
                write_site(child, args.out, on_progress=lambda m: print(f"  {m}", flush=True))
            else:
                build_dataset(
                    child,
                    args.out,
                    processes=args.processes,
                    verify=not args.no_verify,
                    with_site=not args.no_site,
                    overwrite=args.overwrite,
                    on_progress=lambda m: print(f"  {m}", flush=True),
                )
            ok.append(dsname)
        except StopAndAsk as e:
            print(f"  fitsgl build: {dsname}: STOP: {e}", file=sys.stderr)
            failures.append((dsname, str(e)))
        except (FileNotFoundError, ValueError) as e:
            print(f"  fitsgl build: {dsname}: {e}", file=sys.stderr)
            failures.append((dsname, str(e)))

    print(f"\nworkspace build: {len(ok)}/{n} field(s) ok" + (f", {len(failures)} failed" if failures else ""))
    for dsname, msg in failures:
        print(f"  {dsname}: FAILED — {msg}")
    return 1 if failures else 0


def _cmd_index(args: argparse.Namespace) -> int:
    try:
        ws, names = _load_workspace_validated(args.workspace)
    except (FileNotFoundError, ValueError) as e:
        print(f"fitsgl index: {e}", file=sys.stderr)
        return 2
    coll = ws.collection
    name = coll.name if coll is not None else ws.name
    title = coll.title if coll is not None else ws.title
    field_specs = [
        (field_prefix(ref, dsname), args.out / dsname, ref.title) for ref, dsname in zip(ws.fields, names)
    ]
    try:
        result = emit_collection(
            args.out, name=name, title=title, field_specs=field_specs,
            on_progress=lambda m: print(m, flush=True),
        )
    except FileNotFoundError as e:
        print(f"fitsgl index: {e}", file=sys.stderr)
        return 2
    print(f"wrote collection landing page -> {result.staging_dir} ({len(result.fields)} field(s))")
    if result.skipped:
        print(f"  skipped (not built): {', '.join(result.skipped)}")
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


def _cmd_deploy_workspace(args: argparse.Namespace) -> int:
    if args.concurrency is not None and args.concurrency < 1:
        print("fitsgl deploy: --concurrency must be >= 1", file=sys.stderr)
        return 2
    try:
        ws, names = _load_workspace_validated(args.workspace)
        selected = select_fields(ws, args.field, names)
    except (FileNotFoundError, ValueError) as e:
        print(f"fitsgl deploy: {e}", file=sys.stderr)
        return 2
    if ws.deploy is None:
        print(
            "fitsgl deploy: the workspace has no [deploy] table — add one with bucket/endpoint/base_url "
            "(see docs/workspace-design.md)",
            file=sys.stderr,
        )
        return 2
    if not selected:
        print("fitsgl deploy: no fields selected", file=sys.stderr)
        return 2

    # Pre-flight: every selected field must be built before we touch the network.
    missing = [dsname for _, dsname in selected if not (args.out / dsname / "fitsgl.json").is_file()]
    if missing:
        print(f"fitsgl deploy: not built: {', '.join(missing)} — run `fitsgl build -w ...` first", file=sys.stderr)
        return 2

    concurrency = args.concurrency if args.concurrency is not None else ws.deploy.concurrency
    # A DeployConfig holding just the workspace-shared bits (prefix "" + base_url): it
    # sources the single R2 target/purger AND is the collection-root deploy config.
    root_config = DeployConfig(
        bucket=ws.deploy.bucket,
        endpoint=ws.deploy.endpoint,
        public_url=ws.deploy.base_url.rstrip("/"),
        zone_id=ws.deploy.zone_id,
        prefix="",
        viewer_origin=ws.deploy.viewer_origin,
        tile_max_age=ws.deploy.tile_max_age,
        swr_grace=ws.deploy.swr_grace,
        concurrency=concurrency,
    )

    # Credentials from a .env once, relative to the workspace toml dir.
    env_path = args.env_file if args.env_file is not None else ws.config_dir / ".env"
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

    # One target + purger for the shared bucket/zone (each field's DeployConfig only
    # varies prefix/public_url, which deploy_dataset reads from its config arg).
    try:
        target = R2Target.from_config(root_config, concurrency=concurrency)
        purger = CloudflarePurge.from_config(root_config)
    except DeployError as e:
        print(f"fitsgl deploy: {e}", file=sys.stderr)
        return 2
    if purger is None and not args.dry_run:
        print("fitsgl deploy: note: no zone_id/CLOUDFLARE_API_TOKEN → the edge purge will be skipped", file=sys.stderr)

    # Bucket CORS once for the shared bucket (skipped on dry-run / site-only).
    if not args.dry_run and not args.site_only:
        try:
            target.put_cors([ws.deploy.viewer_origin], ["GET", "HEAD"], ["range"])
            print(f"set CORS (origin {ws.deploy.viewer_origin}) on bucket {ws.deploy.bucket!r}", flush=True)
        except DeployError as e:
            print(f"fitsgl deploy: {e}", file=sys.stderr)
            return 1

    n = len(selected)
    uploaded: list[tuple[FieldRef, str]] = []  # fields whose bytes uploaded (verify aside)
    aborted: list[str] = []
    upload_failed: list[tuple[str, str]] = []  # DeployError on a field (or the root)
    verify_failed: list[str] = []  # uploaded fine, but the live post-deploy verify failed
    for i, (ref, dsname) in enumerate(selected, 1):
        dc = field_deploy_config(ws, ref, dsname)
        print(f"\n[{i}/{n}] field {dsname} -> {dc.public_url}", flush=True)
        confirm = None if (args.yes or args.dry_run) else _confirm_deploy(dc.bucket)
        try:
            result = deploy_dataset(
                args.out / dsname,
                dc,
                target,
                purger=purger,
                dry_run=args.dry_run,
                run_verify=not args.no_verify,
                site_only=args.site_only,
                set_cors=False,
                max_workers=concurrency,
                confirm=confirm,
                on_progress=lambda m: print(f"  {m}", flush=True),
            )
        except DeployError as e:
            print(f"  fitsgl deploy: {dsname}: {e}", file=sys.stderr)
            upload_failed.append((dsname, str(e)))
            continue
        if result.aborted:
            print(f"  {dsname}: aborted (declined)")
            aborted.append(dsname)
            continue
        # The bytes are in the bucket. Verify is a separate, environment-dependent
        # check of the LIVE CDN (Range/MIME/the .fits.fz Cache Rule); surface its
        # report — print it in full on any failure/warning so the cause is visible
        # (this is what the single-dataset path does), a one-liner when clean.
        uploaded.append((ref, dsname))
        rep = result.verify_report
        if rep is not None:
            if rep.failures or rep.warnings:
                print(format_report(rep))
            else:
                print(f"  ✓ verify passed ({len(rep.checks)} checks)")
            if not rep.ok():
                verify_failed.append(dsname)

    # Collection landing page: refresh + deploy on a FULL deploy where every selected
    # field's bytes UPLOADED (no upload error, none declined). Gated on upload, NOT
    # verify: a verify failure means the bytes are in the bucket but the live CDN check
    # failed — a setup item (Cache Rule / custom-domain) that affects the landing page
    # too, reported + failing the command, but it must not block publishing the index.
    # Still guarded so a half-failed run never clobbers the live collection.json with a
    # shrunken one. A subset deploy leaves the root alone; a dry-run only previews.
    all_uploaded = len(uploaded) == n
    if args.field is not None:
        print("\nnote: subset deploy — the collection landing page was not refreshed "
              "(run a full `fitsgl deploy -w ...`, or `fitsgl index`, to update it)")
    elif args.dry_run:
        print("\ndry run: would also emit + deploy the collection landing page")
    elif all_uploaded:
        coll = ws.collection
        cname = coll.name if coll is not None else ws.name
        ctitle = coll.title if coll is not None else ws.title
        field_specs = [(field_prefix(ref, dsname), args.out / dsname, ref.title) for ref, dsname in uploaded]
        try:
            emit_collection(
                args.out, name=cname, title=ctitle, field_specs=field_specs,
                on_progress=lambda m: print(f"  {m}", flush=True),
            )
            print(f"\ndeploying collection landing page ({len(field_specs)} field(s)) -> {ws.deploy.base_url}", flush=True)
            deploy_collection_root(args.out, root_config, target, purger=purger, max_workers=concurrency)
        except (DeployError, FileNotFoundError) as e:
            print(f"fitsgl deploy: collection root: {e}", file=sys.stderr)
            upload_failed.append(("<collection>", str(e)))
    else:
        print("\nnote: some fields did not upload (failed/declined) — left the collection landing "
              "page unchanged (re-run a full `fitsgl deploy -w ...` once all fields upload, or `fitsgl index`)")

    verb = "would deploy" if args.dry_run else "uploaded"
    count = len(selected) if args.dry_run else len(uploaded)
    extra = []
    if upload_failed:
        extra.append(f"{len(upload_failed)} failed")
    if verify_failed:
        extra.append(f"{len(verify_failed)} verify-failed")
    if aborted:
        extra.append(f"{len(aborted)} declined")
    print(
        f"\nworkspace {'dry run' if args.dry_run else 'deploy'} ({ws.deploy.bucket!r}): {count}/{n} field(s) {verb}"
        + (" — " + ", ".join(extra) if extra else "")
    )
    for dsname, msg in upload_failed:
        print(f"  {dsname}: ERROR — {msg}")
    if verify_failed:
        print(f"  verify failed (uploaded, but the live check did not pass): {', '.join(verify_failed)}")
        print(
            "  → the bytes are deployed; this is usually the one-time `.fits.fz` Cache Rule / "
            "custom-domain setup. Re-run `fitsgl verify <public_url>` for the per-check detail "
            "(see docs/r2-setup.md)."
        )
    return 1 if (upload_failed or verify_failed) else 0


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    # --field only makes sense under -w; reject it on the single-dataset path rather
    # than silently ignoring a (possibly mistyped) selector.
    if args.command in ("build", "deploy") and args.field is not None and args.workspace is None:
        print(f"fitsgl {args.command}: --field requires -w/--workspace", file=sys.stderr)
        return 2
    if args.command == "init":
        return _cmd_init(args)
    if args.command == "build":
        return _cmd_build_workspace(args) if args.workspace is not None else _cmd_build(args)
    if args.command == "demo":
        return _cmd_demo(args)
    if args.command == "serve":
        return _cmd_serve(args)
    if args.command == "verify":
        return _cmd_verify(args)
    if args.command == "deploy":
        return _cmd_deploy_workspace(args) if args.workspace is not None else _cmd_deploy(args)
    if args.command == "index":
        return _cmd_index(args)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
