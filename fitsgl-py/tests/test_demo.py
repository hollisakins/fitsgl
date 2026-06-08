"""`fitsgl demo` — synthetic dataset generation, build, and CLI wiring."""

import json

import pytest

from fitsgl.cli import main
from fitsgl.demo import DEMO_BANDS, DEMO_RGB, build_demo


def _build(tmp_path, **kw):
    # size 64 → a single level; verify off + one worker keeps the test fast and
    # deterministic (no per-level read-back, no process pool).
    return build_demo(tmp_path / "dist", size=64, verify=False, processes=1, **kw)


def test_build_demo_produces_trilogy_site(tmp_path):
    result = _build(tmp_path)
    ds = result.dataset_dir
    assert ds == tmp_path / "dist" / "demo"

    # Self-contained deployable site: every band pyramid + the vendored viewer.
    for slug, _label, _seed in DEMO_BANDS:
        assert (ds / slug / "manifest.json").is_file()
    assert (ds / "index.html").is_file()
    assert (ds / "assets").is_dir()
    assert (ds / "catalog.csv").is_file()  # markers overlaid by default

    cfg = json.loads((ds / "fitsgl.json").read_text())
    names = [b["name"] for b in cfg["dataset"]["bands"]]
    assert names == [slug for slug, _l, _s in DEMO_BANDS]
    dv = cfg["defaultView"]
    # RGB trilogy default → the band-weight knobs render on load.
    assert dv["mode"] == "rgb"
    assert dv["stretch"] == {"mode": "trilogy"}
    assert (dv["r"], dv["g"], dv["b"]) == (DEMO_RGB["r"], DEMO_RGB["g"], DEMO_RGB["b"])


def test_build_demo_without_catalog(tmp_path):
    result = _build(tmp_path, with_catalog=False)
    assert not (result.dataset_dir / "catalog.csv").exists()


def test_build_demo_rejects_nonpositive_size(tmp_path):
    with pytest.raises(ValueError, match="positive pixel count"):
        build_demo(tmp_path / "dist", size=0)


def test_demo_cli_builds_and_reports(tmp_path, capsys):
    code = main(
        ["demo", "-o", str(tmp_path / "dist"), "--name", "d", "--size", "64", "--no-verify", "--no-catalog"]
    )
    assert code == 0
    assert (tmp_path / "dist" / "d" / "fitsgl.json").is_file()
    out = capsys.readouterr().out
    assert "rgb trilogy" in out
    assert "fitsgl serve" in out  # no --serve → prints the preview hint


def test_demo_cli_rejects_bad_size(tmp_path, capsys):
    code = main(["demo", "-o", str(tmp_path / "dist"), "--size", "0"])
    assert code == 2
    assert "size" in capsys.readouterr().err
