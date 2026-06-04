#!/usr/bin/env python3
"""Generate golden grid-compatibility fixtures for the TS client (M4, D7).

The browser decides whether two single-band pyramids can be composited (same
pixel grid + WCS) with `gridsMatch`, which compares parsed WCS sky positions at
the image corners + centre within a sub-pixel tolerance, plus EXACT shape. This
script records pairs of (flat WCS header dict, shape) — exactly the manifest
form, round-tripped through ``WCS.to_header(relax=True)`` — together with the
expected match/no-match verdict astropy implies. ``grid-match.test.ts`` loads
only this JSON and never calls astropy.

Cases span: identical grids; CD-matrix vs PC+CDELT encodings of one grid; tiny
sub-tolerance offsets (must still MATCH — no rounding-bucket cliff); a
just-over-tolerance offset and a half-pixel offset (REJECT); a rotation (REJECT);
an off-by-one shape with otherwise-matching WCS (REJECT on exact shape); and the
WCS-less pixel-grid cases. The tolerance is GRID_MATCH_TOLERANCE_ARCSEC = 1e-3".

Run from anywhere:  python generate_grid_fixtures.py
Writes:             grid_fixtures.json  (next to this script)
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from astropy.wcs import WCS

ARCSEC = 1.0 / 3600.0
SCALE_ARCSEC = 30.0  # per-pixel scale of the reference grid
SHAPE = [512, 512]


def make_wcs(crval, crpix, scale_arcsec, roll_deg) -> WCS:
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.cunit = ["deg", "deg"]
    w.wcs.crpix = list(crpix)  # FITS 1-based
    w.wcs.crval = list(crval)
    w.wcs.radesys = "ICRS"
    s = scale_arcsec * ARCSEC
    th = np.radians(roll_deg)
    rot = np.array([[np.cos(th), -np.sin(th)], [np.sin(th), np.cos(th)]])
    cd0 = np.array([[-s, 0.0], [0.0, s]])  # standard parity (RA increases to -x)
    w.wcs.cd = rot @ cd0
    return w


def header_dict(w: WCS, cd_form: bool = False) -> dict:
    """Flat {keyword: value} dict the manifest carries (pipeline's path)."""
    hdr = w.to_header(relax=True)
    out = {k: hdr[k] for k in hdr}
    if cd_form:
        cd = w.wcs.cd
        for k in ("PC1_1", "PC1_2", "PC2_1", "PC2_2", "CDELT1", "CDELT2"):
            out.pop(k, None)
        out["CD1_1"], out["CD1_2"] = float(cd[0, 0]), float(cd[0, 1])
        out["CD2_1"], out["CD2_2"] = float(cd[1, 0]), float(cd[1, 1])
    return out


# Reference grid + variants.
REF_CRVAL = (150.0, 2.2)
REF_CRPIX = (256.5, 256.5)
ref = make_wcs(REF_CRVAL, REF_CRPIX, SCALE_ARCSEC, 0.0)

# The match tolerance is a FRACTION of a pixel (GRID_MATCH_SUBPIXEL_FRACTION),
# anchored to the band's pixel scale — so straddle it in PIXELS, not absolute
# arcsec. A dec offset translates the field rigidly, so corner separation equals
# the offset; convert a pixel fraction to a dec offset via the pixel scale.
SUBPIXEL_FRACTION = 0.05
WITHIN = 0.02 * SCALE_ARCSEC * ARCSEC  # 0.02 px < 0.05 px -> match
OVER = 0.1 * SCALE_ARCSEC * ARCSEC  # 0.10 px > 0.05 px -> reject

cases = [
    {
        "name": "identical",
        "a": {"wcs": header_dict(ref), "shape": SHAPE},
        "b": {"wcs": header_dict(ref), "shape": SHAPE},
        "match": True,
    },
    {
        "name": "cd_vs_pc_cdelt_same_grid",
        "a": {"wcs": header_dict(ref, cd_form=False), "shape": SHAPE},
        "b": {"wcs": header_dict(ref, cd_form=True), "shape": SHAPE},
        "match": True,
    },
    {
        "name": "within_tolerance_dec_offset",
        "a": {"wcs": header_dict(ref), "shape": SHAPE},
        "b": {
            "wcs": header_dict(make_wcs((150.0, 2.2 + WITHIN), REF_CRPIX, SCALE_ARCSEC, 0.0)),
            "shape": SHAPE,
        },
        "match": True,
    },
    {
        "name": "just_over_tolerance_dec_offset",
        "a": {"wcs": header_dict(ref), "shape": SHAPE},
        "b": {
            "wcs": header_dict(make_wcs((150.0, 2.2 + OVER), REF_CRPIX, SCALE_ARCSEC, 0.0)),
            "shape": SHAPE,
        },
        "match": False,
    },
    {
        "name": "half_pixel_crpix_offset",
        "a": {"wcs": header_dict(ref), "shape": SHAPE},
        "b": {
            "wcs": header_dict(make_wcs(REF_CRVAL, (257.0, 256.5), SCALE_ARCSEC, 0.0)),
            "shape": SHAPE,
        },
        "match": False,
    },
    {
        "name": "rotated_one_degree",
        "a": {"wcs": header_dict(ref), "shape": SHAPE},
        "b": {
            "wcs": header_dict(make_wcs(REF_CRVAL, REF_CRPIX, SCALE_ARCSEC, 1.0)),
            "shape": SHAPE,
        },
        "match": False,
    },
    {
        "name": "different_scale",
        "a": {"wcs": header_dict(ref), "shape": SHAPE},
        "b": {
            "wcs": header_dict(make_wcs(REF_CRVAL, REF_CRPIX, SCALE_ARCSEC * 1.01, 0.0)),
            "shape": SHAPE,
        },
        "match": False,
    },
    {
        "name": "off_by_one_shape_same_wcs",
        "a": {"wcs": header_dict(ref), "shape": SHAPE},
        "b": {"wcs": header_dict(ref), "shape": [512, 511]},
        "match": False,
    },
    {
        # No WCS on either side: aligned by the pixel grid (shape) alone.
        "name": "pixel_only_same_shape",
        "a": {"wcs": {}, "shape": SHAPE},
        "b": {"wcs": {}, "shape": SHAPE},
        "match": True,
    },
    {
        "name": "pixel_only_different_shape",
        "a": {"wcs": {}, "shape": SHAPE},
        "b": {"wcs": {}, "shape": [256, 256]},
        "match": False,
    },
    {
        # One sky-registered, one not — refuse rather than guess.
        "name": "wcs_vs_pixel_only",
        "a": {"wcs": header_dict(ref), "shape": SHAPE},
        "b": {"wcs": {}, "shape": SHAPE},
        "match": False,
    },
]

fixture = {
    "astropy_version": __import__("astropy").__version__,
    "reference": "astropy.wcs TAN/ICRS; gridsMatch sub-pixel-fraction tolerance, exact shape",
    "subpixel_fraction": SUBPIXEL_FRACTION,
    "cases": cases,
}

out_path = Path(__file__).with_name("grid_fixtures.json")
out_path.write_text(json.dumps(fixture, indent=2) + "\n")
print(f"wrote {out_path}  ({len(cases)} grid cases)")
for c in cases:
    print(f"  {c['name']}: match={c['match']}")
