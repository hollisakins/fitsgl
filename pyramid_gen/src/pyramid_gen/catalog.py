"""Catalog (overlay) export for FitsGL.

Writes a source catalog to the CSV the browser overlay reads -- the SSG-grade
"CSV of RA/Dec" path (M3). The format is the v1 overlay contract, matched
exactly by the client's ``parseCatalogCSV``:

* a leading ``# fitsgl-catalog v1`` version line, so a future breaking change is
  detectable rather than silently misread;
* a header row whose column names match the client's ``MarkerInput`` fields;
* one row per source.

Columns: ``id, x, y, ra, dec, flux``. ``x``/``y`` are the catalog's 0-based array
pixel positions (the convention astropy ``pixel_to_world(..., 0)`` and the client
both use; the client maps ``x`` -> world ``x + 0.5``). ``ra``/``dec`` are ICRS
degrees and are the authoritative position the client renders. Floats are written
at full precision so sub-pixel placement cannot drift. Extra catalog columns are
preserved (the client folds unknown columns into per-marker ``data``).
"""

from __future__ import annotations

from pathlib import Path

import pandas as pd

#: The overlay/catalog format major version this writer emits.
CATALOG_VERSION = 1

#: Known columns, in the order they are written (when present).
KNOWN_COLUMNS = ["id", "x", "y", "ra", "dec", "flux"]


def write_catalog_csv(catalog: pd.DataFrame, path: str | Path) -> Path:
    """Write ``catalog`` to ``path`` as a v1 overlay CSV; returns the path.

    Synthesizes an ``id`` column (``src_0000`` ...) when absent. Known columns are
    written first in ``KNOWN_COLUMNS`` order, then any extra columns (preserved).
    NaN values are written as ``nan`` so they round-trip through the client/pandas.
    """
    path = Path(path)
    df = catalog.copy()
    if "id" not in df.columns:
        df.insert(0, "id", [f"src_{i:04d}" for i in range(len(df))])

    known = [c for c in KNOWN_COLUMNS if c in df.columns]
    extras = [c for c in df.columns if c not in KNOWN_COLUMNS]
    df = df[known + extras]

    with path.open("w", newline="") as f:
        f.write(f"# fitsgl-catalog v{CATALOG_VERSION}\n")
        df.to_csv(f, index=False, float_format="%.17g", na_rep="nan")
    return path
