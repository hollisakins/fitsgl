"""Tests for `fitsgl init` scaffolding (init_scaffold.py)."""

import numpy as np
import pytest
from astropy.io import fits

from fitsgl.config import load_config
from fitsgl.init_scaffold import (
    discover_fits,
    render_toml,
    sanitize_band_name,
    scan_directory,
    write_scaffold,
)
from fitsgl.synthetic import generate_synthetic_mosaic


def _write_band(path, *, rotation=0.0, seed=1, shape=(64, 64)):
    img, hdr, _ = generate_synthetic_mosaic(shape=shape, n_sources=5, rotation_deg=rotation, seed=seed)
    fits.PrimaryHDU(data=img, header=hdr).writeto(path, overwrite=True)


def _write_band_hdr(path, cards, *, rotation=0.0, seed=1, shape=(64, 64)):
    """Write a synthetic mosaic with extra header cards (TELESCOP/INSTRUME/FILTER/...)
    stamped in, so `scan_directory` can detect a real filter."""
    img, hdr, _ = generate_synthetic_mosaic(shape=shape, n_sources=5, rotation_deg=rotation, seed=seed)
    for k, v in cards.items():
        hdr[k] = v
    fits.PrimaryHDU(data=img, header=hdr).writeto(path, overwrite=True)


def _nircam(filt):
    return {"TELESCOP": "JWST", "INSTRUME": "NIRCAM", "FILTER": filt, "PUPIL": "CLEAR"}


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
    # The commented [deploy] stub is present but inert (load_config sees no [deploy]).
    assert "# [deploy]" in toml_text and "bucket" in toml_text
    assert cfg.deploy is None


def test_deploy_stub_round_trips_when_uncommented(tmp_path):
    # A producer who uncomments the whole [deploy] block must get valid config — the
    # scaffold's `prefix = ""` line in particular must parse (it's the default).
    _write_band(tmp_path / "f150w.fits", seed=1)
    plan = scan_directory(tmp_path)
    toml_text = render_toml(plan, tmp_path)

    out_lines, in_deploy = [], False
    for ln in toml_text.splitlines():
        if ln.startswith("# [deploy]"):
            in_deploy = True
        out_lines.append(ln[2:] if (in_deploy and ln.startswith("# ")) else ln)
    toml_path = tmp_path / "fitsgl.toml"
    toml_path.write_text("\n".join(out_lines) + "\n")

    cfg = load_config(toml_path)
    assert cfg.deploy is not None
    assert cfg.deploy.bucket == "my-bucket" and cfg.deploy.prefix == "" and cfg.deploy.target == "r2"


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


def test_scan_detects_filter_labels(tmp_path):
    for i, filt in enumerate(["F150W", "F277W", "F444W"]):
        _write_band_hdr(tmp_path / f"{i}.fits", _nircam(filt), seed=i + 1)
    plan = scan_directory(tmp_path)
    by_name = {b.name: b for b in plan.bands}
    assert set(by_name) == {"f150w", "f277w", "f444w"}
    assert by_name["f444w"].label == "F444W"  # bare filter token, no instrument prefix
    toml_text = render_toml(plan, tmp_path)
    assert 'name = "f444w"' in toml_text and 'label = "F444W"' in toml_text


def test_scan_auto_picks_rgb(tmp_path):
    for i, filt in enumerate(["F150W", "F277W", "F444W"]):
        _write_band_hdr(tmp_path / f"{i}.fits", _nircam(filt), seed=i + 1)
    plan = scan_directory(tmp_path)
    assert plan.default_view == {"mode": "rgb", "r": "f444w", "g": "f277w", "b": "f150w"}

    toml_path = tmp_path / "fitsgl.toml"
    toml_path.write_text(render_toml(plan, tmp_path))
    cfg = load_config(toml_path)  # the RGB scaffold must round-trip to a valid config
    assert cfg.viewer.mode == "rgb"
    assert (cfg.viewer.r, cfg.viewer.g, cfg.viewer.b) == ("f444w", "f277w", "f150w")


def test_scan_rgb_spreads_with_many_broadbands(tmp_path):
    # 5 broadbands: R=reddest, B=bluest, G=broadband nearest the mid-wavelength.
    for i, filt in enumerate(["F090W", "F150W", "F200W", "F356W", "F444W"]):
        _write_band_hdr(tmp_path / f"{i}.fits", _nircam(filt), seed=i + 1)
    plan = scan_directory(tmp_path)
    # pivots ≈ 0.90, 1.50, 1.99, 3.56, 4.42; midpoint ≈ 2.66 -> nearest is F200W.
    assert plan.default_view == {"mode": "rgb", "r": "f444w", "g": "f200w", "b": "f090w"}


def test_scan_single_default_when_few_broadbands(tmp_path):
    # Only 2 wide filters (+ a pupil narrowband) -> keep the single-band default.
    _write_band_hdr(tmp_path / "a.fits", _nircam("F150W"), seed=1)
    _write_band_hdr(tmp_path / "b.fits", _nircam("F444W"), seed=2)
    _write_band_hdr(tmp_path / "c.fits", {"TELESCOP": "JWST", "INSTRUME": "NIRCAM", "FILTER": "F322W2", "PUPIL": "F323N"}, seed=3)
    plan = scan_directory(tmp_path)
    assert plan.default_view == {"mode": "single", "band": "f150w"}


def test_scan_falls_back_to_filename_for_unknown_header(tmp_path):
    _write_band(tmp_path / "myimage.fits", seed=1)  # no band keywords -> undetected
    plan = scan_directory(tmp_path)
    assert plan.bands[0].name == "myimage" and plan.bands[0].label is None
    assert plan.default_view == {"mode": "single", "band": "myimage"}


def test_scan_disambiguates_cross_instrument_collision(tmp_path):
    # F150W on both NIRCam and NIRISS -> instrument-prefixed; the unique F277W stays bare.
    _write_band_hdr(tmp_path / "a.fits", _nircam("F150W"), seed=1)
    _write_band_hdr(tmp_path / "b.fits", {"TELESCOP": "JWST", "INSTRUME": "NIRISS", "FILTER": "F150W", "PUPIL": "CLEARP"}, seed=2)
    _write_band_hdr(tmp_path / "c.fits", _nircam("F277W"), seed=3)
    plan = scan_directory(tmp_path)
    assert {b.label for b in plan.bands} == {"NIRCam F150W", "NIRISS F150W", "F277W"}
    assert {b.name for b in plan.bands} == {"nircam-f150w", "niriss-f150w", "f277w"}


def test_scan_rgb_default_stays_within_one_grid_group(tmp_path):
    # Three co-gridded broadbands + an off-grid (rolled) one — RGB must come from the
    # co-gridded group so the composite can actually form (no cross-grid spanning).
    for i, filt in enumerate(["F150W", "F277W", "F444W"]):
        _write_band_hdr(tmp_path / f"{i}.fits", _nircam(filt), seed=i + 1, rotation=0.0)
    _write_band_hdr(tmp_path / "z.fits", _nircam("F356W"), seed=9, rotation=30.0)
    plan = scan_directory(tmp_path)
    dv = plan.default_view
    assert dv["mode"] == "rgb"
    group_of = {n: gi for gi, names in enumerate(plan.groups_in_order()) for n in names}
    assert len({group_of[dv["r"]], group_of[dv["g"]], group_of[dv["b"]]}) == 1


def test_write_scaffold_refuses_overwrite_without_force(tmp_path):
    _write_band(tmp_path / "a.fits", seed=1)
    plan = scan_directory(tmp_path)
    write_scaffold(plan, tmp_path, force=False)
    with pytest.raises(FileExistsError):
        write_scaffold(plan, tmp_path, force=False)
    # --force overwrites.
    assert write_scaffold(plan, tmp_path, force=True).name == "fitsgl.toml"
