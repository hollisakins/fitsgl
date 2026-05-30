"""Tests for the catalog (overlay) CSV export."""

import numpy as np
import pandas as pd

from pyramid_gen.catalog import CATALOG_VERSION, KNOWN_COLUMNS, write_catalog_csv
from pyramid_gen.synthetic import generate_synthetic_mosaic


def test_writes_version_line_and_header(tmp_path):
    _img, _hdr, cat = generate_synthetic_mosaic(n_sources=10)
    out = write_catalog_csv(cat, tmp_path / "catalog.csv")
    lines = out.read_text().splitlines()
    assert lines[0] == f"# fitsgl-catalog v{CATALOG_VERSION}"
    header = lines[1].split(",")
    # The synthetic catalog has x,y,ra,dec,flux; an id column is synthesized.
    assert header == KNOWN_COLUMNS


def test_roundtrip_radec_and_synthesized_id(tmp_path):
    _img, _hdr, cat = generate_synthetic_mosaic(n_sources=15, seed=3)
    out = write_catalog_csv(cat, tmp_path / "c.csv")
    df = pd.read_csv(out, comment="#")
    assert len(df) == len(cat)
    assert df["id"].iloc[0] == "src_0000"
    # Full-precision floats: ra/dec survive the round-trip exactly.
    np.testing.assert_allclose(df["ra"].to_numpy(), cat["ra"].to_numpy(), rtol=0, atol=1e-12)
    np.testing.assert_allclose(df["dec"].to_numpy(), cat["dec"].to_numpy(), rtol=0, atol=1e-12)
    np.testing.assert_allclose(df["x"].to_numpy(), cat["x"].to_numpy(), rtol=0, atol=1e-12)


def test_nan_flux_roundtrips_as_nan(tmp_path):
    cat = pd.DataFrame({"x": [1.0], "y": [2.0], "ra": [10.0], "dec": [20.0], "flux": [np.nan]})
    out = write_catalog_csv(cat, tmp_path / "c.csv")
    df = pd.read_csv(out, comment="#")
    assert np.isnan(df["flux"].iloc[0])


def test_existing_id_column_is_preserved(tmp_path):
    cat = pd.DataFrame({"id": ["a", "b"], "ra": [1.0, 2.0], "dec": [3.0, 4.0]})
    out = write_catalog_csv(cat, tmp_path / "c.csv")
    df = pd.read_csv(out, comment="#")
    assert list(df["id"]) == ["a", "b"]


def test_extra_columns_are_preserved(tmp_path):
    cat = pd.DataFrame({"ra": [1.0], "dec": [2.0], "snr": [7.5], "band": ["F200W"]})
    out = write_catalog_csv(cat, tmp_path / "c.csv")
    df = pd.read_csv(out, comment="#")
    assert df["snr"].iloc[0] == 7.5
    assert df["band"].iloc[0] == "F200W"
