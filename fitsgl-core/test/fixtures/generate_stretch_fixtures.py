#!/usr/bin/env python3
"""Generate golden stretch-curve fixtures for the TypeScript renderer (M1).

The viewer applies a non-linear transfer function in the fragment shader on top
of the linear min/max normalization. The reference for the two non-linear modes
is astropy.visualization, the canonical implementation:

* ``log``   -> ``LogStretch(a=1000)``   : ``log(a*x + 1) / log(a + 1)``
* ``asinh`` -> ``AsinhStretch(a=0.1)``  : ``arcsinh(x/a) / arcsinh(1/a)``

Both operate on ``x`` already normalized to ``[0, 1]`` (the min/max interval step
happens first), and both map ``[0, 1] -> [0, 1]`` with fixed endpoints
``f(0)=0``, ``f(1)=1``. The softening constants are FIXED (decision D5) and must
match ``LOG_SOFTENING`` / ``ASINH_SOFTENING`` in ``src/renderer/stretch.ts``.

The TypeScript ``applyStretch`` must reproduce these values; the same closed
forms are also inlined into the GLSL fragment shader from the same constants, so
the pure-TS reference and the shader cannot drift.

Run from anywhere:  python generate_stretch_fixtures.py
Writes:             stretch_fixtures.json  (next to this script)
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from astropy.visualization import AsinhStretch, LogStretch

LOG_SOFTENING = 1000.0
ASINH_SOFTENING = 0.1

# A dense sweep over [0, 1] plus the exact endpoints and a few values chosen to
# exercise the steep part of each curve near zero (where faint detail lives).
xs = np.unique(
    np.concatenate(
        [
            np.linspace(0.0, 1.0, 65),
            np.array([0.0, 1e-4, 1e-3, 1e-2, 0.05, 0.1, 0.25, 0.5, 0.75, 1.0]),
        ]
    )
).astype(np.float64)

log_stretch = LogStretch(a=LOG_SOFTENING)
asinh_stretch = AsinhStretch(a=ASINH_SOFTENING)

# clip=False: we want the raw curve value; the TS side clamps the *input* to
# [0,1] before calling applyStretch, so the curve itself is evaluated on [0,1].
log_out = log_stretch(xs.copy(), clip=False)
asinh_out = asinh_stretch(xs.copy(), clip=False)

samples = [
    {"x": float(x), "log": float(lo), "asinh": float(ai)}
    for x, lo, ai in zip(xs, log_out, asinh_out)
]

fixture = {
    "log_softening": LOG_SOFTENING,
    "asinh_softening": ASINH_SOFTENING,
    "reference": "astropy.visualization LogStretch(a=1000), AsinhStretch(a=0.1)",
    "astropy_version": __import__("astropy").__version__,
    "samples": samples,
}

out_path = Path(__file__).with_name("stretch_fixtures.json")
out_path.write_text(json.dumps(fixture, indent=2) + "\n")
print(f"wrote {out_path}  ({len(samples)} samples)")
