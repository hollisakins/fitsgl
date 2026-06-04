#!/usr/bin/env python3
"""Generate golden WCS fixtures for the TypeScript client (M2).

The browser computes pixel<->sky itself (no astropy on the client). astropy is
the canonical reference: for several TAN WCS configurations this records the
flat header dict the manifest would carry (round-tripped through
``WCS.to_header(relax=True)`` exactly as the pipeline does), a grid of
pixel->world samples, world->pixel samples, and the pixel-space directions of
+Dec (North) and +RA (East) at the image centre for the North-up orientation
test. ``wcs.test.ts`` loads only this JSON and never calls astropy.

Coordinate conventions:
* Pixel samples are astropy 0-based (``origin=0``), i.e. integer = pixel centre.
  The renderer's *world* coordinate is ``x0 + 0.5``; the TS side applies that
  shift, so the JSON stays in astropy's native convention.
* North/East vectors are stored as world-space pixel displacements; because
  world and astropy-0-based differ by a constant 0.5, the displacement is the
  same in either system.

Run from anywhere:  python generate_wcs_fixtures.py
Writes:             wcs_fixtures.json  (next to this script)
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from astropy.wcs import WCS

ARCSEC = 1.0 / 3600.0


def make_wcs(crval, crpix, scale_arcsec, roll_deg, mirror=False) -> WCS:
    """A TAN WCS rotated by roll. Standard parity (det(CD)<0, RA increases to -x)
    unless ``mirror`` (det(CD)>0), which exercises the no-flip orientation branch."""
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.cunit = ["deg", "deg"]
    w.wcs.crpix = list(crpix)  # FITS 1-based
    w.wcs.crval = list(crval)
    w.wcs.radesys = "ICRS"
    s = scale_arcsec * ARCSEC
    th = np.radians(roll_deg)
    rot = np.array([[np.cos(th), -np.sin(th)], [np.sin(th), np.cos(th)]])
    sx = s if mirror else -s  # mirror parity: RA increases to +x (det(CD) > 0)
    cd0 = np.array([[sx, 0.0], [0.0, s]])
    w.wcs.cd = rot @ cd0
    return w


def header_dict(w: WCS) -> dict:
    """The flat {keyword: value} dict the manifest carries (pipeline's path)."""
    hdr = w.to_header(relax=True)
    return {k: hdr[k] for k in hdr}


def sample_grid(shape: tuple[int, int], n: int = 5) -> tuple[np.ndarray, np.ndarray]:
    """An n×n grid of 0-based pixel coordinates spanning the image, plus centre."""
    h, w = shape
    xs = np.linspace(0, w - 1, n)
    ys = np.linspace(0, h - 1, n)
    gx, gy = np.meshgrid(xs, ys)
    return gx.ravel(), gy.ravel()


def build_config(name: str, shape, crval, crpix, scale_arcsec, roll_deg, cd_form=False, mirror=False):
    w = make_wcs(crval, crpix, scale_arcsec, roll_deg, mirror=mirror)
    hdr = header_dict(w)
    if cd_form:
        # Force the CD-matrix representation (exercise the parser's CD branch).
        cd = w.wcs.cd
        for k in ("PC1_1", "PC1_2", "PC2_1", "PC2_2", "CDELT1", "CDELT2"):
            hdr.pop(k, None)
        hdr["CD1_1"], hdr["CD1_2"] = float(cd[0, 0]), float(cd[0, 1])
        hdr["CD2_1"], hdr["CD2_2"] = float(cd[1, 0]), float(cd[1, 1])
    # Re-parse from the dict so the reference matches exactly what TS sees.
    w2 = WCS({k: v for k, v in hdr.items()})

    gx, gy = sample_grid(shape)
    sky = w2.pixel_to_world(gx, gy)  # SkyCoord, ICRS
    p2w = [
        {"x0": float(x), "y0": float(y), "ra": float(c.ra.deg), "dec": float(c.dec.deg)}
        for x, y, c in zip(gx, gy, sky)
    ]

    # Inverse: take the p2w sky coords back to pixels via astropy world_to_pixel.
    px, py = w2.world_to_pixel(sky)
    w2p = [
        {"ra": float(c.ra.deg), "dec": float(c.dec.deg), "x0": float(x), "y0": float(y)}
        for c, x, y in zip(sky, px, py)
    ]

    # North (+Dec) and East (+RA) directions in world/pixel space at image centre.
    h, wd = shape
    cx_world, cy_world = wd / 2.0, h / 2.0
    cx0, cy0 = cx_world - 0.5, cy_world - 0.5  # astropy 0-based centre
    c0 = w2.pixel_to_world(cx0, cy0)
    ra0, dec0 = float(c0.ra.deg), float(c0.dec.deg)
    eps = 1e-4  # deg
    xn, yn = w2.world_to_pixel_values(ra0, dec0 + eps)
    xe, ye = w2.world_to_pixel_values(ra0 + eps / np.cos(np.radians(dec0)), dec0)
    north_vec = [float(xn - cx0), float(yn - cy0)]
    east_vec = [float(xe - cx0), float(ye - cy0)]

    return {
        "name": name,
        "shape": [int(shape[0]), int(shape[1])],
        "wcs": hdr,
        "center_world": [cx_world, cy_world],
        "p2w": p2w,
        "w2p": w2p,
        "north_vec": north_vec,
        "east_vec": east_vec,
    }


configs = [
    build_config("axis_aligned", (512, 512), (150.0, 2.2), (256.5, 256.5), 30.0, 0.0),
    build_config("rolled_30", (512, 512), (150.0, 2.2), (256.5, 256.5), 30.0, 30.0),
    build_config("rolled_115", (480, 640), (34.5, -5.1), (300.0, 240.0), 50.0, 115.0),
    build_config("near_pole", (512, 512), (80.0, 89.6), (256.5, 256.5), 30.0, 20.0),
    build_config("ra_wrap", (512, 512), (0.05, 10.0), (256.5, 256.5), 60.0, 0.0),
    build_config("cd_form", (512, 512), (150.0, 2.2), (256.5, 256.5), 30.0, 12.0, cd_form=True),
    # Mirror parity (det(CD) > 0): exercises the no-flip branch of northUpOrientation.
    build_config("mirror_parity", (512, 512), (150.0, 2.2), (256.5, 256.5), 30.0, 20.0, mirror=True),
]

fixture = {
    "astropy_version": __import__("astropy").__version__,
    "reference": "astropy.wcs pixel_to_world / world_to_pixel, ICRS TAN",
    "configs": configs,
}

out_path = Path(__file__).with_name("wcs_fixtures.json")
out_path.write_text(json.dumps(fixture, indent=2) + "\n")
print(f"wrote {out_path}  ({len(configs)} WCS configs)")
for c in configs:
    print(f"  {c['name']}: {len(c['p2w'])} p2w samples, north={c['north_vec']}, east={c['east_vec']}")
