"""Manifest schema and IO for FITS pyramids.

The manifest is a small JSON sidecar describing every level of a pyramid. It is
a *convenience* index for the browser client: the client must still treat each
.fits.fz file as self-describing and verify the actual compression type from
the file's ZCMPTYPE keyword rather than trusting the manifest's hint.
"""

from __future__ import annotations

import dataclasses
import json
from dataclasses import dataclass, field
from pathlib import Path

# v2 adds per-level `supertiles[]` (a level chunked under the CDN object-size limit,
# or parsed from a pre-tiled input mosaic — see docs/supertile-design.md). A level
# read without `supertiles` (legacy v1) is shimmed to one full-grid supertile, and a
# single-supertile level is the degenerate, common case.
MANIFEST_VERSION = 2


@dataclass
class SupertileInfo:
    """One standalone ``.fits.fz`` holding a contiguous rectangle of a level's tiles."""

    filename: str
    tile_origin: list[int]  # [tile_x0, tile_y0] — local (0,0) tile in the level grid
    tile_count: list[int]  # [n_tiles_x, n_tiles_y] — this supertile's own tile grid

    def to_dict(self) -> dict:
        return {
            "filename": self.filename,
            "tile_origin": list(self.tile_origin),
            "tile_count": list(self.tile_count),
        }

    @classmethod
    def from_dict(cls, d: dict) -> "SupertileInfo":
        return cls(
            filename=d["filename"],
            tile_origin=list(d["tile_origin"]),
            tile_count=list(d["tile_count"]),
        )


@dataclass
class LevelInfo:
    """Metadata for a single pyramid level."""

    z: int
    filename: str  # the level's single file (v1) / first supertile's file
    compression: str  # "GZIP_2" or "RICE_1" -- client hint, verify via ZCMPTYPE
    lossless: bool
    shape: list[int]  # [H, W]
    fpack_tile_count: list[int]  # [n_tiles_y, n_tiles_x] — the level's TOTAL grid
    pixel_scale_arcsec: float
    wcs: dict  # FITS WCS header as a flat {keyword: value} dict
    supertiles: list[SupertileInfo]  # disjoint files paving the level grid (≥1)

    def to_dict(self) -> dict:
        return dataclasses.asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "LevelInfo":
        fpack_tile_count = list(d["fpack_tile_count"])
        raw = d.get("supertiles")
        if raw is None:
            # v1 shim: one supertile covering the whole grid ([ny, nx] -> [nx, ny]).
            n_ty, n_tx = fpack_tile_count
            supertiles = [
                SupertileInfo(filename=d["filename"], tile_origin=[0, 0], tile_count=[n_tx, n_ty])
            ]
        else:
            supertiles = [SupertileInfo.from_dict(s) for s in raw]
        return cls(
            z=d["z"],
            filename=d["filename"],
            compression=d["compression"],
            lossless=d["lossless"],
            shape=list(d["shape"]),
            fpack_tile_count=fpack_tile_count,
            pixel_scale_arcsec=d["pixel_scale_arcsec"],
            wcs=dict(d["wcs"]),
            supertiles=supertiles,
        )


@dataclass
class Manifest:
    """Top-level pyramid manifest."""

    source_file: str
    native_shape: list[int]  # [H, W]
    n_levels: int  # N, the deepest z index (so there are N+1 levels)
    levels: list[LevelInfo] = field(default_factory=list)
    fpack_tile_size: int = 256
    version: int = MANIFEST_VERSION

    def to_dict(self) -> dict:
        # Field order chosen to match the documented schema for readability.
        return {
            "version": self.version,
            "source_file": self.source_file,
            "native_shape": list(self.native_shape),
            "fpack_tile_size": self.fpack_tile_size,
            "n_levels": self.n_levels,
            "levels": [lvl.to_dict() for lvl in self.levels],
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Manifest":
        return cls(
            version=d.get("version", MANIFEST_VERSION),
            source_file=d["source_file"],
            native_shape=list(d["native_shape"]),
            fpack_tile_size=d.get("fpack_tile_size", 256),
            n_levels=d["n_levels"],
            levels=[LevelInfo.from_dict(x) for x in d["levels"]],
        )


def write_manifest(path: str | Path, manifest: Manifest) -> None:
    """Serialize a manifest to JSON on disk."""
    path = Path(path)
    with path.open("w") as f:
        json.dump(manifest.to_dict(), f, indent=2, sort_keys=False)
        f.write("\n")


def read_manifest(path: str | Path) -> Manifest:
    """Load a manifest from JSON on disk."""
    path = Path(path)
    with path.open() as f:
        return Manifest.from_dict(json.load(f))
