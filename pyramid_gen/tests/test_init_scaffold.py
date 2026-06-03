"""Tests for `fitsgl init` scaffolding (init_scaffold.py)."""

import numpy as np
import pytest
from astropy.io import fits

from pyramid_gen.config import load_config
from pyramid_gen.init_scaffold import (
    discover_fits,
    render_toml,
    sanitize_band_name,
    scan_directory,
    write_scaffold,
)
from pyramid_gen.synthetic import generate_synthetic_mosaic


def _write_band(path, *, rotation=0.0, seed=1, shape=(64, 64)):
    img, hdr, _ = generate_synthetic_mosaic(shape=shape, n_sources=5, rotation_deg=rotation, seed=seed)
    fits.PrimaryHDU(data=img, header=hdr).writeto(path, overwrite=True)


def test_discover_fits_globs_and_exclusions(tmp_path):
    for name in ("a.fits", "b.fit", "c.fits.gz", "out.fits.fz", "notes.txt"):
        (tmp_path / name).write_bytes(b"")
    found = {p.name for p in discover_fits(tmp_path)}
    assert found == {"a.fits", "b.fit", "c.fits.gz"}  # .fits.fz (output) and .txt excluded


def test_sanitize_band_name(tmp_path):
    taken: set[str] = set()
    assert sanitize_band_name("f444w", taken) == "f444w"
    taken.add("f444w")
    assert sanitize_band_name("f444w", taken) == "f444w_2"  # dedupe
    assert sanitize_band_name("my band!", set()) == "my_band_"  # char scrub
    assert sanitize_band_name("catalog", set()) == "catalog_1"  # reserved dodge


def test_scan_groups_cogridded_bands(tmp_path):
    _write_band(tmp_path / "f150w.fits", rotation=0.0, seed=1)
    _write_band(tmp_path / "f277w.fits", rotation=0.0, seed=2)  # same WCS -> same grid
    _write_band(tmp_path / "ground.fits", rotation=30.0, seed=3)  # rolled WCS -> different grid
    plan = scan_directory(tmp_path)

    assert {b.name for b in plan.bands} == {"f150w", "f277w", "ground"}
    groups = plan.groups_in_order()
    assert len(groups) == 2
    cogridded = next(g for g in groups if len(g) == 2)
    assert set(cogridded) == {"f150w", "f277w"}
    assert plan.skipped == []


def test_scan_skips_ambiguous_multi_hdu(tmp_path):
    _write_band(tmp_path / "good.fits", seed=1)
    a = np.zeros((16, 16), dtype="float32")
    fits.HDUList([fits.PrimaryHDU(data=a), fits.ImageHDU(data=a)]).writeto(tmp_path / "cube.fits", overwrite=True)
    plan = scan_directory(tmp_path)

    assert {b.name for b in plan.bands} == {"good"}
    assert len(plan.skipped) == 1
    skipped_path, reason = plan.skipped[0]
    assert skipped_path.name == "cube.fits" and "multiple 2D image HDUs" in reason


def test_scan_raises_on_empty_directory(tmp_path):
    with pytest.raises(ValueError, match="no usable FITS"):
        scan_directory(tmp_path)


def test_render_toml_round_trips_through_load_config(tmp_path):
    _write_band(tmp_path / "f150w.fits", seed=1)
    _write_band(tmp_path / "f277w.fits", seed=2)
    plan = scan_directory(tmp_path)

    toml_text = render_toml(plan, tmp_path)
    toml_path = tmp_path / "fitsgl.toml"
    toml_path.write_text(toml_text)

    cfg = load_config(toml_path)  # the strongest check: the scaffold is valid input
    assert [b.name for b in cfg.bands] == ["f150w", "f277w"]
    assert cfg.bands[0].inputs[0].name == "f150w.fits"
    assert cfg.viewer.mode == "single" and cfg.viewer.band == "f150w"
    # The grid-group guidance is present as a comment.
    assert "Grid groups" in toml_text


def test_render_toml_emits_label_for_sanitized_name(tmp_path):
    import warnings as w

    _write_band(tmp_path / "f150w.v1.fits", seed=1)  # the '.' in the stem gets sanitized
    plan = scan_directory(tmp_path)
    toml_text = render_toml(plan, tmp_path)
    assert 'name = "f150w_v1"' in toml_text and 'label = "f150w.v1"' in toml_text

    toml_path = tmp_path / "fitsgl.toml"
    toml_path.write_text(toml_text)
    with w.catch_warnings(record=True) as rec:
        w.simplefilter("always")
        cfg = load_config(toml_path)
    assert cfg.bands[0].name == "f150w_v1" and cfg.bands[0].label == "f150w.v1"
    assert not any("not URL-safe" in str(r.message) for r in rec)  # the emitted label silences it


def test_write_scaffold_refuses_overwrite_without_force(tmp_path):
    _write_band(tmp_path / "a.fits", seed=1)
    plan = scan_directory(tmp_path)
    write_scaffold(plan, tmp_path, force=False)
    with pytest.raises(FileExistsError):
        write_scaffold(plan, tmp_path, force=False)
    # --force overwrites.
    assert write_scaffold(plan, tmp_path, force=True).name == "fitsgl.toml"
