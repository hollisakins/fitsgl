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

MANIFEST_VERSION = 1


@dataclass
class LevelInfo:
    """Metadata for a single pyramid level."""

    z: int
    filename: str
    compression: str  # "GZIP_2" or "RICE_1" -- client hint, verify via ZCMPTYPE
    lossless: bool
    shape: list[int]  # [H, W]
    fpack_tile_count: list[int]  # [n_tiles_y, n_tiles_x]
    pixel_scale_arcsec: float
    wcs: dict  # FITS WCS header as a flat {keyword: value} dict

    def to_dict(self) -> dict:
        return dataclasses.asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "LevelInfo":
        return cls(
            z=d["z"],
            filename=d["filename"],
            compression=d["compression"],
            lossless=d["lossless"],
            shape=list(d["shape"]),
            fpack_tile_count=list(d["fpack_tile_count"]),
            pixel_scale_arcsec=d["pixel_scale_arcsec"],
            wcs=dict(d["wcs"]),
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
