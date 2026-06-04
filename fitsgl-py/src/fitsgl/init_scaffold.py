"""``fitsgl init`` — scan a directory of FITS mosaics and scaffold a ``fitsgl.toml``.

Pure scaffolding logic (no pixel decode, no multiprocessing): discover FITS files,
read each header-only to get its shape + WCS, group bands by the advisory
``grid_hash`` (so the scaffold can *tell the user* which bands are co-gridded and
therefore RGB-combinable), and hand-serialize a starter ``fitsgl.toml``.

By design init does NOT guess an RGB view — it scaffolds a single-band default and
leaves the RGB role assignment to the user (the grid-group comments show which
bands are valid together). The toml is the review surface; init is batch-only.
"""

from __future__ import annotations

import os
import re
import warnings
from dataclasses import dataclass, field
from pathlib import Path, PurePath

from astropy.io import fits
from astropy.wcs import WCS

from .config import sanitize_band_name
from .dataset import grid_hash

#: Globs scanned (non-recursive). `.fits.fz` is intentionally excluded — it is a
#: build *output*, not an input.
FITS_GLOBS = ("*.fits", "*.fit", "*.fits.gz")


@dataclass
class ScannedBand:
    """One discovered FITS mosaic, read header-only (no pixels decoded)."""

    path: Path
    name: str
    shape: list[int]  # [H, W]
    grid_hash: str


@dataclass
class InitPlan:
    """The resolved scaffold, ready to serialize / summarize."""

    name: str  # dataset name (slug from the directory)
    bands: list[ScannedBand]
    #: grid_hash -> [band names], insertion-ordered (group 0 = first-seen grid).
    grid_groups: dict[str, list[str]] = field(default_factory=dict)
    #: (file, reason) for files that could not be scanned.
    skipped: list[tuple[Path, str]] = field(default_factory=list)

    def groups_in_order(self) -> list[list[str]]:
        """Grid groups as ordered lists of band names (group 0 first)."""
        return list(self.grid_groups.values())


def discover_fits(directory: Path) -> list[Path]:
    """Top-level FITS mosaics in ``directory`` (sorted, deduped). Non-recursive."""
    found: dict[Path, None] = {}
    for pattern in FITS_GLOBS:
        for p in directory.glob(pattern):
            if p.is_file():
                found[p.resolve()] = None
    return sorted(found, key=lambda p: p.name)


def _strip_fits_suffix(filename: str) -> str:
    """Drop a trailing FITS suffix (incl. double like ``.fits.gz``)."""
    name = filename
    low = name.lower()
    for comp in (".fz", ".gz"):
        if low.endswith(comp):
            name = name[: -len(comp)]
            low = name.lower()
            break
    for base in (".fits", ".fit"):
        if low.endswith(base):
            name = name[: -len(base)]
            break
    return name


def read_header_only(path: Path) -> tuple[fits.Header, list[int]]:
    """The 2D image HDU's header + ``[H, W]`` shape, WITHOUT decoding pixels.

    Mirrors :func:`build_pyramid._read_input`'s HDU selection but reads only
    ``hdu.shape`` (header-derived). Raises ``ValueError`` on no / ambiguous 2D
    image HDU so the caller can record it as skipped (init is lenient).
    """
    with fits.open(path) as hdul:
        shaped = [
            (i, tuple(hdu.shape))
            for i, hdu in enumerate(hdul)
            if isinstance(getattr(hdu, "shape", None), tuple) and len(hdu.shape) >= 2
        ]
        two_d = [(i, s) for i, s in shaped if len(s) == 2]
        if len(two_d) > 1:
            raise ValueError(f"multiple 2D image HDUs {[i for i, _ in two_d]}; unclear which is the mosaic")
        if not two_d:
            raise ValueError("no 2D image HDU found")
        idx, shape = two_d[0]
        header = hdul[idx].header.copy()
    return header, [int(shape[0]), int(shape[1])]


def _wcs_dict(header: fits.Header) -> dict:
    """The canonical WCS dict (matches the pipeline's z=0 form, so ``grid_hash``
    here equals what ``build`` will later compute)."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        hdr = WCS(header).to_header(relax=True)
    return {k: hdr[k] for k in hdr}


def _slug(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return s or "dataset"


def scan_directory(directory: Path) -> InitPlan:
    """Scan ``directory`` for FITS mosaics and build the scaffold plan.

    Lenient: files that can't be read header-only (or are ambiguous) are recorded
    in ``skipped`` and the scan continues. Raises ``ValueError`` only when no
    usable band is found at all.
    """
    directory = directory.resolve()
    if not directory.is_dir():
        raise ValueError(f"not a directory: {directory}")
    files = discover_fits(directory)
    bands: list[ScannedBand] = []
    skipped: list[tuple[Path, str]] = []
    taken: set[str] = set()
    groups: dict[str, list[str]] = {}

    for path in files:
        try:
            header, shape = read_header_only(path)
            ghash = grid_hash(_wcs_dict(header), shape)
        except Exception as e:  # noqa: BLE001 - lenient scan: skip + record, keep going
            skipped.append((path, str(e)))
            continue
        name = sanitize_band_name(_strip_fits_suffix(path.name), taken)
        taken.add(name)
        bands.append(ScannedBand(path=path, name=name, shape=shape, grid_hash=ghash))
        groups.setdefault(ghash, []).append(name)

    if not bands:
        detail = "; ".join(f"{p.name}: {why}" for p, why in skipped)
        raise ValueError(
            f"no usable FITS mosaics found in {directory}"
            + (f" ({len(skipped)} skipped: {detail})" if skipped else "")
        )
    return InitPlan(name=_slug(directory.name), bands=bands, grid_groups=groups, skipped=skipped)


def _toml_str(value: str) -> str:
    """A TOML basic string (quote + escape backslash/quote/control)."""
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    escaped = escaped.replace("\n", "\\n").replace("\t", "\\t").replace("\r", "\\r")
    return f'"{escaped}"'


def _rel_posix(target: Path, start: Path) -> str:
    return PurePath(os.path.relpath(os.fspath(target), os.fspath(start))).as_posix()


def render_toml(plan: InitPlan, config_dir: Path) -> str:
    """Hand-serialize ``plan`` to a ``fitsgl.toml`` string.

    Single-band default; the grid groups are surfaced as comments so the user
    knows which bands are co-gridded (RGB-combinable). Output is guaranteed to
    round-trip through :func:`config.load_config`.
    """
    config_dir = config_dir.resolve()
    groups = plan.groups_in_order()
    lines: list[str] = [
        "# fitsgl.toml — generated by `fitsgl init`. Edit, then run `fitsgl build`.",
        "",
        "[dataset]",
        f"name = {_toml_str(plan.name)}",
        '# title = "..."',
        '# catalog = "sources.csv"   # optional ra/dec (or x/y) CSV overlay',
        "",
        "# Grid groups (bands sharing a WCS grid can be combined as an RGB composite):",
    ]
    for gi, names in enumerate(groups):
        tag = "co-gridded → RGB-able" if len(names) >= 2 else "own grid"
        lines.append(f"#   group {gi} ({tag}): {', '.join(names)}")
    lines.append("")

    for band in plan.bands:
        lines += [
            "[[dataset.bands]]",
            f"name = {_toml_str(band.name)}",
        ]
        stem = _strip_fits_suffix(band.path.name)
        if stem != band.name:
            # The slug was sanitized from the filename; surface the original as a label.
            lines.append(f"label = {_toml_str(stem)}")
        lines += [
            f"input = {_toml_str(_rel_posix(band.path, config_dir))}",
            "",
        ]

    lines += [
        "[build]",
        "quantize_level = 8",
        "tile_size = 256",
        "",
        "[viewer]",
        'default = "single"',
        f"band = {_toml_str(plan.bands[0].name)}",
        '# stretch = "asinh"   # linear | log | asinh',
        "# north_up = true",
    ]
    rgb_group = next((g for g in groups if len(g) >= 3), None)
    lines.append("#")
    if rgb_group is not None:
        lines += [
            "# To show an RGB composite instead, pick three co-gridded bands, e.g.:",
            '#   default = "rgb"',
            f"#   r = {_toml_str(rgb_group[0])}",
            f"#   g = {_toml_str(rgb_group[1])}",
            f"#   b = {_toml_str(rgb_group[2])}",
        ]
    else:
        lines.append("# (no co-gridded group of >=3 bands found, so RGB is not offered as a default)")

    # Commented [deploy] stub — fill in + uncomment to enable `fitsgl deploy` to
    # Cloudflare R2. Secrets never live in this file: `fitsgl deploy` reads them from
    # the environment or a `.env` next to this fitsgl.toml (R2_ACCESS_KEY_ID /
    # R2_SECRET_ACCESS_KEY and, for the edge purge, CLOUDFLARE_API_TOKEN). The secrets
    # note below sits ABOVE `# [deploy]` so it stays a comment even when the block is
    # uncommented wholesale (see test_deploy_stub_round_trips_when_uncommented).
    lines += [
        "",
        "# Secrets are NOT set here — put R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY (and",
        "# CLOUDFLARE_API_TOKEN for the edge purge) in your shell or a git-ignored .env",
        "# next to this file. See docs/r2-setup.md.",
        "# [deploy]                 # `fitsgl deploy` target — Cloudflare R2 (see docs/deploy-design.md §5.3)",
        '# target = "r2"',
        '# bucket = "my-bucket"',
        '# endpoint = "https://<account-id>.r2.cloudflarestorage.com"',
        '# public_url = "https://data.example.org/' + plan.name + '"   # where it is served (the cached custom domain)',
        '# zone_id = "<cloudflare-zone-id>"   # optional; enables the post-deploy edge purge',
        '# prefix = ""                # optional key prefix within the bucket',
        '# viewer_origin = "*"        # CORS Allow-Origin for cross-site embedding',
        "# tile_max_age = 604800      # seconds the edge serves a tile before revalidating (default 7d)",
        "# concurrency = 8            # parallel upload streams to R2 (default 8; --concurrency overrides)",
    ]
    return "\n".join(lines) + "\n"


def write_scaffold(plan: InitPlan, config_dir: Path, *, force: bool) -> Path:
    """Write ``fitsgl.toml`` into ``config_dir`` (atomically). Refuse to clobber an
    existing file unless ``force``."""
    config_dir = Path(config_dir)
    target = config_dir / "fitsgl.toml"
    if target.exists() and not force:
        raise FileExistsError(f"{target} already exists; pass --force to overwrite")
    text = render_toml(plan, config_dir)
    tmp = config_dir / ".fitsgl.toml.tmp"
    tmp.write_text(text)
    os.replace(tmp, target)
    return target
