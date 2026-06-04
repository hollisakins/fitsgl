#!/usr/bin/env python3
"""Generate built-in colormap LUTs for the TypeScript renderer (M1, decision D6).

For single-band view the viewer maps the post-stretch scalar in ``[0, 1]`` through
a 1-D colormap LUT. The bundled palettes are matplotlib's perceptually-uniform
maps plus a plain grayscale ramp; matplotlib is the canonical reference.

Each map is sampled to a fixed ``SIZE``-entry RGB table (8-bit per channel) by
evaluating the colormap on ``linspace(0, 1, SIZE)``. The table is emitted two
ways:

* ``rgb``  -- the flat ``SIZE*3`` byte list, the exact golden reference the
  TypeScript test asserts against; and
* ``b64``  -- the same bytes base64-encoded, which is what ships embedded in
  ``src/renderer/colormap-data.ts`` (a GENERATED module: the library has no
  JSON/asset loading step, so the data lives in source like the shaders do).

This script writes both outputs from the same sampling, so they cannot disagree
at generation time. ``colormaps.test.ts`` decodes the base64 from the generated
``colormap-data.ts`` (via the ``colormaps.ts`` API) and asserts it equals
``rgb`` here, guarding against later hand-edits or a decode bug.

Run from anywhere:  python generate_colormap_fixtures.py
Writes:             colormap_fixtures.json       (next to this script)
                    ../../src/renderer/colormap-data.ts  (generated module)
"""

from __future__ import annotations

import base64
import json
from pathlib import Path

import matplotlib as mpl
import numpy as np

SIZE = 256
NAMES = ["gray", "viridis", "magma", "inferno", "plasma", "cividis"]


def lut_rgb(name: str) -> np.ndarray:
    """SIZE x 3 uint8 RGB table sampled evenly over the colormap's [0, 1] domain."""
    cmap = mpl.colormaps[name]
    rgba = cmap(np.linspace(0.0, 1.0, SIZE))  # SIZE x 4 float in [0, 1]
    rgb = np.round(rgba[:, :3] * 255.0).astype(np.uint8)
    return rgb


fixture: dict[str, object] = {
    "size": SIZE,
    "names": NAMES,
    "reference": "matplotlib.colormaps[name] sampled on linspace(0,1,256)",
    "matplotlib_version": mpl.__version__,
    "colormaps": {},
}

for name in NAMES:
    rgb = lut_rgb(name)
    flat = rgb.reshape(-1)  # row-major R,G,B,R,G,B,...
    fixture["colormaps"][name] = {
        "rgb": [int(v) for v in flat],
        "b64": base64.b64encode(flat.tobytes()).decode("ascii"),
    }

out_path = Path(__file__).with_name("colormap_fixtures.json")
out_path.write_text(json.dumps(fixture, indent=2) + "\n")
print(f"wrote {out_path}  ({len(NAMES)} colormaps x {SIZE} entries)")

# Also emit the shipped data module. Keeping NAMES order stable here fixes the
# declared order of the ColormapName union / COLORMAP_NAMES list on the TS side.
ts_lines = [
    "/**",
    " * GENERATED FILE — do not edit by hand.",
    " *",
    " * Built-in colormap LUTs for the renderer (decision D6). Regenerate with:",
    " *   python test/fixtures/generate_colormap_fixtures.py",
    " *",
    " * Each value is base64 of a row-major SIZE×3 (R,G,B) byte table sampled from",
    " * the matplotlib colormap of the same name. Consumed by `colormaps.ts`.",
    " */",
    "",
    f"export const COLORMAP_SIZE = {SIZE};",
    "",
    "export const COLORMAP_RGB_B64 = {",
]
for name in NAMES:
    ts_lines.append(f"  {name}: '{fixture['colormaps'][name]['b64']}',")
ts_lines.append("} as const;")
ts_text = "\n".join(ts_lines) + "\n"

ts_path = (Path(__file__).resolve().parents[2] / "src" / "renderer" / "colormap-data.ts")
ts_path.write_text(ts_text)
print(f"wrote {ts_path}")
