"""fitsgl: build multi-resolution fpacked FITS pyramids from mosaics.

Phase 1 of a browser-side FITS mosaic renderer. For each input mosaic this
package produces N+1 separate fpacked FITS files, one per resolution level.

Every level (z=0..N) uses RICE_1 with quantize_level=8 and SUBTRACTIVE_DITHER_2
-- a lossy, display-only product (q=8 preserves photometry to ~0.03% on real
data). The raw, lossless science mosaic is distributed separately, not here.

All levels share a 256x256 fpack-internal tile size, the unit of HTTP byte
ranges the browser client requests.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

#: Public API symbol -> the submodule that defines it. Resolved lazily by
#: ``__getattr__`` (PEP 562) so ``import fitsgl`` (and any ``import fitsgl.<sub>``)
#: stays cheap: pulling in ``build_pyramid`` eagerly here would drag astropy +
#: numpy into *every* command — including light ones like ``fitsgl index`` /
#: ``serve`` / ``--help`` that never touch a pyramid. They load on first access.
_LAZY_EXPORTS = {
    "FPACK_TILE_SIZE": "build_pyramid",
    "build_pyramid": "build_pyramid",
    "n_levels": "build_pyramid",
    "LevelInfo": "manifest",
    "Manifest": "manifest",
    "SupertileInfo": "manifest",
    "read_manifest": "manifest",
    "write_manifest": "manifest",
}

__all__ = list(_LAZY_EXPORTS)

__version__ = "0.1.0"

if TYPE_CHECKING:  # let type-checkers/IDEs still see the re-exports
    from .build_pyramid import FPACK_TILE_SIZE, build_pyramid, n_levels
    from .manifest import LevelInfo, Manifest, SupertileInfo, read_manifest, write_manifest


def __getattr__(name: str) -> Any:
    module = _LAZY_EXPORTS.get(name)
    if module is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    import importlib

    return getattr(importlib.import_module(f".{module}", __name__), name)


def __dir__() -> list[str]:
    return sorted(__all__)
