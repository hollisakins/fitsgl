"""Dataset manifest: groups single-band pyramids for RGB compositing (M4, D7/D9).

A *dataset manifest* is an ADDITIVE sidecar that sits above the per-pyramid
manifests (decision D9). It lists the available bands -- each with the canonical
WCS grid parameters and a grid hash -- plus an optional default RGB role
assignment. The per-pyramid ``manifest.json`` schema is UNCHANGED; every existing
single-band pyramid stays valid, and a band is still a normal, independently
renderable pyramid.

The browser composites three bands that share an identical pixel grid + WCS (no
in-browser resampling, D7). Two consumers use this file:

* a band *picker* groups composite-compatible bands without fetching every
  per-band manifest -- which is why each band carries its canonical WCS params
  (ctype/shape/crpix/crval/derived-cd) and a ``grid_hash``;
* the *renderer* verifies compatibility structurally from each band's parsed WCS
  + exact shape (the TS ``gridsMatch``), which is the AUTHORITATIVE gate.

``grid_hash`` is therefore a coarse GROUPING HINT, not the gate. It is
canonicalized over an integer-quantized tuple (exact CTYPE/H/W + quantized
CRPIX/CRVAL/derived-CD) and hashed with FNV-1a, so it is deterministic across
runs and representation-invariant (a CD-matrix header and the equivalent
PC+CDELT header hash identically). Because it is advisory and Python-only, the
client never reproduces it byte-for-byte -- avoiding brittle cross-language
float-formatting/rounding parity.

The derived linear transform mirrors the client's ``parseWcs`` EXACTLY
(``CD`` if present, else ``CDELT_i * PC_ij`` with FITS defaults), so the Python
canonicalization and the TS structural check operate on the same numbers.
"""

from __future__ import annotations

import dataclasses
import json
import math
import os
from dataclasses import dataclass, field
from pathlib import Path, PurePath
from typing import Sequence

from .manifest import Manifest, read_manifest

#: The dataset-manifest schema major version. A new schema (unlike the
#: per-pyramid manifest, D9) so the client may reject an unknown/missing version.
DATASET_VERSION = 1

# Quantization granularity for the (advisory) grid hash. Coarse enough that two
# genuinely co-gridded bands never straddle a bucket boundary, fine enough that a
# half-pixel / half-arcsec offset always lands in a different bucket.
_CRPIX_QUANTUM = 1e-3  # pixels
_CRVAL_QUANTUM = 1e-7  # degrees (~0.36 mas)
_CD_QUANTUM = 1e-11  # degrees/pixel


def _num(wcs: dict, key: str) -> float | None:
    """A finite numeric WCS value, or None (mirrors the client's ``num``)."""
    v = wcs.get(key)
    if isinstance(v, bool):  # bool is an int subclass; never a WCS scalar
        return None
    if isinstance(v, (int, float)) and math.isfinite(v):
        return float(v)
    return None


def derive_cd(wcs: dict) -> tuple[float, float, float, float]:
    """Row-major linear transform ``[cd11, cd12, cd21, cd22]`` (deg/pixel).

    Prefers an explicit CD matrix; otherwise ``CDELT_i * PC_ij`` with the FITS
    defaults (PCi_i=1, PCi_j=0, CDELTi=1). This is a byte-for-byte transcription
    of the TypeScript ``parseWcs`` derivation so both sides canonicalize the
    same grid identically -- the pipeline writes PC+CDELT
    (``WCS.to_header(relax=True)``), the client may also see CD, and both encode
    the same physical grid to the same four numbers.
    """
    has_cd = any(_num(wcs, k) is not None for k in ("CD1_1", "CD1_2", "CD2_1", "CD2_2"))
    if has_cd:
        return (
            _num(wcs, "CD1_1") or 0.0,
            _num(wcs, "CD1_2") or 0.0,
            _num(wcs, "CD2_1") or 0.0,
            _num(wcs, "CD2_2") or 0.0,
        )
    cdelt1 = _num(wcs, "CDELT1")
    cdelt2 = _num(wcs, "CDELT2")
    cdelt1 = 1.0 if cdelt1 is None else cdelt1
    cdelt2 = 1.0 if cdelt2 is None else cdelt2
    pc11 = _num(wcs, "PC1_1")
    pc12 = _num(wcs, "PC1_2")
    pc21 = _num(wcs, "PC2_1")
    pc22 = _num(wcs, "PC2_2")
    pc11 = 1.0 if pc11 is None else pc11
    pc12 = 0.0 if pc12 is None else pc12
    pc21 = 0.0 if pc21 is None else pc21
    pc22 = 1.0 if pc22 is None else pc22
    return (cdelt1 * pc11, cdelt1 * pc12, cdelt2 * pc21, cdelt2 * pc22)


def _quantize(value: float, quantum: float) -> int:
    """Round ``value`` to an integer count of ``quantum`` (round-half-to-even).

    Integer quantization (not a formatted-float string) so the canonical form is
    free of float-repr ambiguity. The rounding mode is part of the spec; it only
    needs to be deterministic on the Python side because the hash is advisory.
    """
    return int(round(value / quantum))


def _fnv1a_32(text: str) -> str:
    """Stable 32-bit FNV-1a hash of ``text`` as 8 hex digits.

    Hand-rolled (no hashlib salt/ordering surprises) so the canonical-string ->
    hash mapping is fixed forever; sufficient for a grouping hint.
    """
    h = 0x811C9DC5
    for byte in text.encode("utf-8"):
        h ^= byte
        h = (h * 0x01000193) & 0xFFFFFFFF
    return f"{h:08x}"


def grid_hash(wcs: dict, shape: Sequence[int]) -> str:
    """Advisory composite-grouping hash over the canonical z=0 grid.

    Inputs: exact CTYPE1/2, exact integer H/W, and quantized CRPIX/CRVAL/derived
    CD. Two bands with the same hash are *likely* composite-compatible; the
    authoritative gate is the client's structural ``gridsMatch``.
    """
    cd = derive_cd(wcs)
    h, w = int(shape[0]), int(shape[1])
    parts = [
        str(wcs.get("CTYPE1", "")).strip(),
        str(wcs.get("CTYPE2", "")).strip(),
        str(h),
        str(w),
        str(_quantize(_num(wcs, "CRPIX1") or 0.0, _CRPIX_QUANTUM)),
        str(_quantize(_num(wcs, "CRPIX2") or 0.0, _CRPIX_QUANTUM)),
        str(_quantize(_num(wcs, "CRVAL1") or 0.0, _CRVAL_QUANTUM)),
        str(_quantize(_num(wcs, "CRVAL2") or 0.0, _CRVAL_QUANTUM)),
        str(_quantize(cd[0], _CD_QUANTUM)),
        str(_quantize(cd[1], _CD_QUANTUM)),
        str(_quantize(cd[2], _CD_QUANTUM)),
        str(_quantize(cd[3], _CD_QUANTUM)),
    ]
    return _fnv1a_32("|".join(parts))


@dataclass
class DatasetBand:
    """One band in a dataset: a stable key + the canonical z=0 grid params.

    ``path`` is a RELATIVE URL (always '/'-separated) from the dataset manifest
    to that band's ``manifest.json``, resolved in the browser with the same
    ``new URL(path, datasetUrl)`` algorithm as per-level filenames. ``shape`` is
    the band's native ``[H, W]`` (== its z=0 level shape). ``cd`` is the derived
    transform (see :func:`derive_cd`).
    """

    name: str
    path: str
    ctype1: str
    ctype2: str
    shape: list[int]  # [H, W]
    crpix: list[float]  # [CRPIX1, CRPIX2]
    crval: list[float]  # [CRVAL1, CRVAL2]
    cd: list[float]  # [cd11, cd12, cd21, cd22]
    pixel_scale_arcsec: float
    grid_hash: str

    def to_dict(self) -> dict:
        return dataclasses.asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "DatasetBand":
        return cls(
            name=d["name"],
            path=d["path"],
            ctype1=d["ctype1"],
            ctype2=d["ctype2"],
            shape=list(d["shape"]),
            crpix=list(d["crpix"]),
            crval=list(d["crval"]),
            cd=list(d["cd"]),
            pixel_scale_arcsec=d["pixel_scale_arcsec"],
            grid_hash=d["grid_hash"],
        )


@dataclass
class DatasetManifest:
    """A group of bands sharing (or claiming to share) a composite-ready grid.

    ``default_rgb`` maps the roles ``r``/``g``/``b`` to band ``name``s; it is the
    single canonical default every delivery tier reads (the schema-freeze
    requires it to exist now even though a given dataset may omit it).
    """

    bands: list[DatasetBand] = field(default_factory=list)
    default_rgb: dict | None = None  # {"r": name, "g": name, "b": name}
    version: int = DATASET_VERSION

    def __post_init__(self) -> None:
        # Mirror the TS reader's contract on the WRITE path so a producer can't
        # ship a file the strict client (`validateDataset`) would reject at load:
        # default_rgb (when present) must have exactly r/g/b string roles, each
        # naming an existing band. Runs for build_dataset, from_dict, and direct
        # construction alike.
        if self.default_rgb is None:
            return
        if set(self.default_rgb.keys()) != {"r", "g", "b"}:
            raise ValueError(
                f"dataset: default_rgb must have exactly keys r/g/b, got {sorted(self.default_rgb)}"
            )
        names = {b.name for b in self.bands}
        for role, name in self.default_rgb.items():
            if not isinstance(name, str):
                raise ValueError(f"dataset: default_rgb.{role} must be a band name string, got {name!r}")
            if name not in names:
                raise ValueError(f"dataset: default_rgb.{role} references unknown band {name!r}")

    def to_dict(self) -> dict:
        return {
            "version": self.version,
            "bands": [b.to_dict() for b in self.bands],
            "default_rgb": self.default_rgb,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "DatasetManifest":
        return cls(
            version=d.get("version", DATASET_VERSION),
            bands=[DatasetBand.from_dict(x) for x in d["bands"]],
            default_rgb=d.get("default_rgb"),
        )


def band_from_manifest(name: str, manifest: Manifest, path: str) -> DatasetBand:
    """Build a :class:`DatasetBand` from a band's parsed per-pyramid manifest.

    Reads the z=0 level's WCS (native grid) + ``native_shape``; the half-pixel
    CRPIX/CD scaling at z>0 is deterministic from z=0, so z=0 defines the grid.
    """
    z0 = next((lvl for lvl in manifest.levels if lvl.z == 0), None)
    if z0 is None:
        raise ValueError(f"dataset: band {name!r} manifest has no z=0 level")
    wcs = z0.wcs
    shape = list(manifest.native_shape)
    cd = derive_cd(wcs)
    ps = z0.pixel_scale_arcsec
    # A non-finite scale would serialize as a bare NaN/Infinity token (invalid
    # JSON the browser cannot parse); fail here, naming the band, instead.
    if not (isinstance(ps, (int, float)) and math.isfinite(ps)):
        raise ValueError(f"dataset: band {name!r} has a non-finite pixel_scale_arcsec ({ps!r})")
    return DatasetBand(
        name=name,
        path=path,
        ctype1=str(wcs.get("CTYPE1", "")).strip(),
        ctype2=str(wcs.get("CTYPE2", "")).strip(),
        shape=[int(shape[0]), int(shape[1])],
        crpix=[_num(wcs, "CRPIX1") or 0.0, _num(wcs, "CRPIX2") or 0.0],
        crval=[_num(wcs, "CRVAL1") or 0.0, _num(wcs, "CRVAL2") or 0.0],
        cd=[cd[0], cd[1], cd[2], cd[3]],
        pixel_scale_arcsec=float(ps),
        grid_hash=grid_hash(wcs, shape),
    )


def _relative_posix_path(target: Path, start: Path) -> str:
    """``target`` relative to ``start``, normalized to a '/'-separated URL path.

    Composed with the stdlib then ``PurePath.as_posix()`` so a dataset built on
    Windows still yields browser-resolvable '/' paths (never ``os.sep``).
    """
    rel = os.path.relpath(os.fspath(target), os.fspath(start))
    posix = PurePath(rel).as_posix()
    # Must stay under the dataset dir: no absolute path (Windows different-drive)
    # and no "../" escape (an SSG serving the dataset dir as the web root could
    # not resolve a path that climbs out of it).
    if PurePath(posix).is_absolute() or posix == ".." or posix.startswith("../"):
        raise ValueError(
            f"dataset: band manifest {target} is not under the dataset dir {start}"
        )
    return posix


def build_dataset(
    bands: Sequence[tuple[str, str | Path]],
    output_path: str | Path,
    *,
    default_rgb: dict | None = None,
) -> DatasetManifest:
    """Assemble a dataset manifest from already-built band pyramids.

    Parameters
    ----------
    bands
        ``(name, manifest_path)`` pairs -- ``name`` is the stable machine key the
        ``default_rgb`` roles reference; ``manifest_path`` points at that band's
        ``manifest.json``. The pyramids must already be built; this only reads
        their manifests (no rebuild, no multiprocessing).
    output_path
        Where ``dataset.json`` will be written; band ``path``s are computed
        relative to its parent directory.
    default_rgb
        Optional ``{"r": name, "g": name, "b": name}``. When omitted and at least
        three bands are given, defaults to the first three in order.

    Returns
    -------
    DatasetManifest
        The manifest, also serialized to ``output_path``.
    """
    output_path = Path(output_path)
    dataset_dir = output_path.parent

    entries: list[DatasetBand] = []
    for name, manifest_path in bands:
        manifest_path = Path(manifest_path)
        manifest = read_manifest(manifest_path)
        rel = _relative_posix_path(manifest_path, dataset_dir)
        entries.append(band_from_manifest(name, manifest, rel))

    if default_rgb is None and len(entries) >= 3:
        default_rgb = {
            "r": entries[0].name,
            "g": entries[1].name,
            "b": entries[2].name,
        }

    manifest = DatasetManifest(bands=entries, default_rgb=default_rgb)
    write_dataset(output_path, manifest)
    return manifest


def write_dataset(path: str | Path, dataset: DatasetManifest) -> None:
    """Serialize a dataset manifest to JSON on disk."""
    path = Path(path)
    with path.open("w") as f:
        # allow_nan=False: a bare NaN/Infinity token is valid Python output but
        # invalid JSON the browser's JSON.parse rejects — fail loudly instead.
        json.dump(dataset.to_dict(), f, indent=2, sort_keys=False, allow_nan=False)
        f.write("\n")


def read_dataset(path: str | Path) -> DatasetManifest:
    """Load a dataset manifest from JSON on disk."""
    path = Path(path)
    with path.open() as f:
        return DatasetManifest.from_dict(json.load(f))
