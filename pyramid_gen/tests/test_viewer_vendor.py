"""Drift guards for the vendored SSG viewer bundle (pyramid_gen/_viewer).

The viewer is a committed build artifact of `fits-pyramid` + the `viewer/` app.
These tests fail loudly when it goes stale, so the SSG can never ship an engine
older than the source in the same checkout:

  - staleness: recompute a fingerprint of the SOURCE the bundle was built from and
    compare it to what `write-build-info.mjs` recorded. The hash spec here MUST be
    byte-identical to that script (see its header comment).
  - schema pin: the bundle's recorded FitsglConfig schemaVersion must equal the
    Python producer's, so `fitsgl build` and the bundled consumer agree on the wire
    format at packaging time.

Skipped when run outside a full repo checkout (e.g. an installed wheel without the
TS source / viewer app), since there is nothing to compare against then.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

import pyramid_gen.fitsgl_config as fc

REPO = Path(__file__).resolve().parents[2]  # tests -> pyramid_gen -> repo root
BUILD_INFO = REPO / "pyramid_gen" / "src" / "pyramid_gen" / "_viewer" / ".build-info.json"
_SOURCE_ROOTS = (REPO / "fits-pyramid" / "src", REPO / "viewer" / "src")

_full_checkout = all(r.is_dir() for r in _SOURCE_ROOTS) and (REPO / "viewer" / "package.json").is_file()
pytestmark = pytest.mark.skipif(not _full_checkout, reason="not a full repo checkout (no TS/viewer source to compare)")


def _source_rels() -> list[str]:
    """Relative POSIX paths of the bundle's source inputs — must match the JS spec."""
    files: list[Path] = []
    for root in _SOURCE_ROOTS:
        files += [p for p in root.rglob("*") if p.is_file()]
    files.append(REPO / "viewer" / "package.json")
    rels = [p.relative_to(REPO).as_posix() for p in files]
    rels = [r for r in rels if not any(seg.startswith(".") for seg in r.split("/")) and ".test." not in r]
    return sorted(rels)


def _source_hash(rels: list[str]) -> str:
    h = hashlib.sha256()
    for rel in rels:
        h.update(rel.encode("utf-8"))
        h.update(b"\0")
        h.update((REPO / rel).read_bytes())
        h.update(b"\0")
    return h.hexdigest()


def test_vendored_viewer_is_fresh():
    assert BUILD_INFO.is_file(), "missing _viewer/.build-info.json — run `npm --prefix viewer run build-vendor`"
    info = json.loads(BUILD_INFO.read_text())
    assert info["sourceHash"] == _source_hash(_source_rels()), (
        "the vendored viewer bundle is stale relative to fits-pyramid/viewer source; "
        "rebuild + commit it: `npm --prefix viewer run build-vendor`"
    )


def test_vendored_viewer_schema_matches_producer():
    info = json.loads(BUILD_INFO.read_text())
    assert info["schemaVersion"] == fc.FITSGL_SCHEMA_VERSION
