"""Catalog ingestion + end-to-end `fitsgl build` orchestration tests."""

import json

import pandas as pd
import pytest
from astropy.io import fits

from pyramid_gen.build import build_dataset
from pyramid_gen.catalog import ingest_catalog, read_catalog_csv, write_catalog_csv
from pyramid_gen.config import load_config
from pyramid_gen.manifest import read_manifest
from pyramid_gen.synthetic import generate_synthetic_mosaic


# ---- catalog ingestion ------------------------------------------------------


def test_ingest_radec_catalog(tmp_path):
    src = tmp_path / "src.csv"
    pd.DataFrame({"ra": [150.0, 150.1], "dec": [2.0, 2.1], "flux": [1.0, 2.0]}).to_csv(src, index=False)
    dest = tmp_path / "catalog.csv"
    out = ingest_catalog(src, dest)
    assert out == dest
    assert dest.read_text().startswith("# fitsgl-catalog v1")
    df = read_catalog_csv(dest)
    assert "id" in df.columns and "ra" in df.columns and len(df) == 2


def test_ingest_accepts_xy_only_catalog(tmp_path):
    src = tmp_path / "src.csv"
    pd.DataFrame({"x": [1, 2], "y": [3, 4]}).to_csv(src, index=False)
    ingest_catalog(src, tmp_path / "out.csv")  # must not raise


def test_ingest_rejects_missing_coordinates(tmp_path):
    src = tmp_path / "src.csv"
    pd.DataFrame({"foo": [1], "bar": [2]}).to_csv(src, index=False)
    with pytest.raises(ValueError, match="ra.*dec.*x.*y"):
        ingest_catalog(src, tmp_path / "out.csv")


def test_ingest_tolerates_existing_version_line(tmp_path):
    src = tmp_path / "src.csv"
    write_catalog_csv(pd.DataFrame({"ra": [1.0], "dec": [2.0]}), src)  # writes the "# fitsgl-catalog v1" line
    out = ingest_catalog(src, tmp_path / "out.csv")
    assert read_catalog_csv(out).shape[0] == 1


# ---- end-to-end build -------------------------------------------------------


def _write_band(tmp_path, name: str, seed: int):
    img, hdr, cat = generate_synthetic_mosaic(shape=(128, 128), n_sources=12, seed=seed)
    fits.PrimaryHDU(data=img, header=hdr).writeto(tmp_path / f"{name}.fits", overwrite=True)
    return cat


def _toml(tmp_path, bands, *, catalog: str | None = None, viewer: str = ""):
    lines = ['[dataset]', 'name = "demo"', 'title = "Demo"']
    if catalog is not None:
        lines.append(f'catalog = "{catalog}"')
    for name, fn in bands:
        lines += ["[[dataset.bands]]", f'name = "{name}"', f'input = "{fn}"']
    lines += ["[build]", "tile_size = 256", "quantize_level = 8"]
    if viewer:
        lines.append(viewer)
    p = tmp_path / "fitsgl.toml"
    p.write_text("\n".join(lines) + "\n")
    return p


def test_build_dataset_end_to_end(tmp_path):
    _write_band(tmp_path, "f150w", 3)
    _write_band(tmp_path, "f277w", 2)
    cat = _write_band(tmp_path, "f444w", 1)
    write_catalog_csv(cat, tmp_path / "sources.csv")

    toml = _toml(
        tmp_path,
        [("f150w", "f150w.fits"), ("f277w", "f277w.fits"), ("f444w", "f444w.fits")],
        catalog="sources.csv",
        viewer='[viewer]\ndefault = "rgb"\nr = "f444w"\ng = "f277w"\nb = "f150w"\nstretch = "asinh"\nnorth_up = true',
    )
    result = build_dataset(load_config(toml), tmp_path / "dist")

    ds = result.dataset_dir
    assert ds == tmp_path / "dist" / "demo"
    for band in ("f150w", "f277w", "f444w"):
        assert (ds / band / "manifest.json").is_file()
    assert (ds / "catalog.csv").is_file()
    assert not (tmp_path / "dist" / ".demo.building").exists()  # temp swapped away

    cfg = json.loads((ds / "fitsgl.json").read_text())
    assert cfg["schemaVersion"] == 1
    assert cfg["dataset"]["title"] == "Demo"
    assert [b["name"] for b in cfg["dataset"]["bands"]] == ["f150w", "f277w", "f444w"]
    assert cfg["dataset"]["bands"][0]["tiles"] == ["f150w/manifest.json"]
    # The synthetic bands share an identical WCS -> one grid group.
    assert {b["grid"]["group"] for b in cfg["dataset"]["bands"]} == {0}
    assert cfg["dataset"]["catalog"] == {"url": "catalog.csv"}
    assert cfg["defaultView"] == {
        "mode": "rgb",
        "r": "f444w",
        "g": "f277w",
        "b": "f150w",
        "stretch": {"mode": "asinh"},
        "northUp": True,
    }


def test_build_dataset_with_pretiled_band(tmp_path):
    """A band delivered as several overlapping tiles (shared grid) assembles into one
    mosaic and flows through build_dataset like any single-FITS band (slice 3)."""
    base, hdr, _ = generate_synthetic_mosaic(shape=(256, 384), n_sources=12, seed=4)

    def crop(x0, x1):
        sub = base[:, x0:x1].copy()
        h = hdr.copy()
        h["CRPIX1"] = float(hdr["CRPIX1"]) - x0
        return sub, h

    a_img, a_hdr = crop(0, 240)
    b_img, b_hdr = crop(176, 384)  # overlap on cols [176:240)
    fits.PrimaryHDU(data=a_img, header=a_hdr).writeto(tmp_path / "f277w_B1.fits", overwrite=True)
    fits.PrimaryHDU(data=b_img, header=b_hdr).writeto(tmp_path / "f277w_B2.fits", overwrite=True)

    toml = tmp_path / "fitsgl.toml"
    toml.write_text(
        '[dataset]\nname = "demo"\n'
        '[[dataset.bands]]\nname = "f277w"\n'
        'input = ["f277w_B1.fits", "f277w_B2.fits"]\n'
        "[build]\ntile_size = 256\nquantize_level = 8\n"
    )
    result = build_dataset(load_config(toml), tmp_path / "dist")

    ds = result.dataset_dir
    m = read_manifest(ds / "f277w" / "manifest.json")
    assert m.version == 2
    assert m.native_shape == [256, 384]  # the two tiles reassembled into one grid
    assert m.levels[0].filename.startswith("f277w_z0")  # multi-tile band -> {slug}_z… names
    assert (ds / "f277w" / m.levels[0].filename).is_file()

    cfg = json.loads((ds / "fitsgl.json").read_text())
    assert [b["name"] for b in cfg["dataset"]["bands"]] == ["f277w"]
    assert cfg["dataset"]["bands"][0]["tiles"] == ["f277w/manifest.json"]


def test_build_with_verify_off(tmp_path):
    _write_band(tmp_path, "img", 1)
    config = load_config(_toml(tmp_path, [("img", "img.fits")]))
    result = build_dataset(config, tmp_path / "dist", verify=False)
    assert (result.dataset_dir / "fitsgl.json").is_file()
    assert (result.dataset_dir / "img" / "manifest.json").is_file()


def test_build_cli_rejects_bad_processes():
    from pyramid_gen.cli import main

    assert main(["build", "--processes", "0"]) == 2  # validated before any IO


def test_build_slugs_band_name_keeps_label(tmp_path):
    import warnings as w

    _write_band(tmp_path, "f277w", 1)  # writes f277w.fits; the band NAME is set separately
    toml = _toml(tmp_path, [("NIRCam F277W", "f277w.fits")])
    with w.catch_warnings():
        w.simplefilter("ignore")  # the not-URL-safe slug warning is expected here
        result = build_dataset(load_config(toml), tmp_path / "dist")

    ds = result.dataset_dir
    assert (ds / "NIRCam_F277W" / "manifest.json").is_file()  # on-disk dir is the slug
    cfg = json.loads((ds / "fitsgl.json").read_text())
    b = cfg["dataset"]["bands"][0]
    assert b["name"] == "NIRCam_F277W" and b["label"] == "NIRCam F277W"
    assert b["tiles"] == ["NIRCam_F277W/manifest.json"]
    assert cfg["defaultView"] == {"mode": "single", "band": "NIRCam_F277W"}


def test_build_emits_site_by_default(tmp_path):
    _write_band(tmp_path, "img", 1)
    config = load_config(_toml(tmp_path, [("img", "img.fits")]))
    result = build_dataset(config, tmp_path / "dist")
    ds = result.dataset_dir
    assert result.site_written is True
    assert (ds / "index.html").is_file()  # self-contained deployable site
    assert (ds / "assets").is_dir()


def test_build_emits_band_histogram_stats(tmp_path):
    _write_band(tmp_path, "img", 1)
    config = load_config(_toml(tmp_path, [("img", "img.fits")]))
    result = build_dataset(config, tmp_path / "dist", with_site=False)
    cfg = json.loads((result.dataset_dir / "fitsgl.json").read_text())
    stats = cfg["dataset"]["bands"][0].get("stats")
    assert stats is not None and "histogram" in stats  # pre-computed for the stretch panel
    h = stats["histogram"]
    assert len(h["counts"]) == 128 and h["lo"] < h["hi"]


def test_build_no_site(tmp_path):
    _write_band(tmp_path, "img", 1)
    config = load_config(_toml(tmp_path, [("img", "img.fits")]))
    result = build_dataset(config, tmp_path / "dist", with_site=False)
    ds = result.dataset_dir
    assert result.site_written is False
    assert not (ds / "index.html").exists()
    assert (ds / "fitsgl.json").is_file()  # data + config still emitted


def test_write_site_refreshes_viewer_without_rebuilding(tmp_path):
    from pyramid_gen.build import write_site

    _write_band(tmp_path, "img", 1)
    config = load_config(_toml(tmp_path, [("img", "img.fits")]))
    out_root = tmp_path / "dist"
    # Build data + config WITHOUT the viewer, then add only the viewer.
    result = build_dataset(config, out_root, with_site=False)
    ds = result.dataset_dir
    assert not (ds / "index.html").exists()
    cfg_before = (ds / "fitsgl.json").read_bytes()
    data_before = (ds / "img" / "manifest.json").read_bytes()

    dataset_dir = write_site(config, out_root)

    assert dataset_dir == ds
    assert (ds / "index.html").is_file() and (ds / "assets").is_dir()  # viewer now present
    # Data + config are byte-for-byte untouched: no pyramid rebuild, no temp swap.
    assert (ds / "fitsgl.json").read_bytes() == cfg_before
    assert (ds / "img" / "manifest.json").read_bytes() == data_before


def test_write_site_requires_existing_dataset(tmp_path):
    from pyramid_gen.build import write_site

    _write_band(tmp_path, "img", 1)
    config = load_config(_toml(tmp_path, [("img", "img.fits")]))
    with pytest.raises(FileNotFoundError, match="run a full"):
        write_site(config, tmp_path / "dist")  # nothing built yet


def test_build_site_only_cli(tmp_path):
    from pyramid_gen.cli import main

    _write_band(tmp_path, "img", 1)
    toml = _toml(tmp_path, [("img", "img.fits")])
    out = tmp_path / "dist"
    build_dataset(load_config(toml), out, with_site=False)  # data only, no viewer

    assert main(["build", "-c", str(toml), "-o", str(out), "--site-only"]) == 0
    assert (out / "demo" / "index.html").is_file()  # viewer refreshed in place


def test_build_site_only_without_prior_build_errors(tmp_path):
    from pyramid_gen.cli import main

    _write_band(tmp_path, "img", 1)
    toml = _toml(tmp_path, [("img", "img.fits")])
    assert main(["build", "-c", str(toml), "-o", str(tmp_path / "dist"), "--site-only"]) == 2


def test_build_no_site_and_site_only_are_mutually_exclusive():
    from pyramid_gen.cli import main

    with pytest.raises(SystemExit):  # argparse rejects the contradictory pair
        main(["build", "--no-site", "--site-only"])


def test_build_single_band_default_and_rerun(tmp_path):
    _write_band(tmp_path, "img", 1)
    config = load_config(_toml(tmp_path, [("img", "img.fits")]))
    out_root = tmp_path / "dist"

    build_dataset(config, out_root)
    result = build_dataset(config, out_root)  # re-runnable: replaces cleanly

    cfg = json.loads((result.dataset_dir / "fitsgl.json").read_text())
    # No [viewer] -> single-band default on the first band.
    assert cfg["defaultView"] == {"mode": "single", "band": "img"}
    assert "catalog" not in cfg["dataset"]
