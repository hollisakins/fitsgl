"""Access + deploy the vendored SSG viewer bundle (``pyramid_gen/_viewer``).

The viewer is a self-contained static site (``index.html`` + ``assets/``) built
from the ``viewer/`` app (``npm run build-vendor``) and committed into the Python
package as data. ``fitsgl build`` copies it next to a dataset's ``fitsgl.json`` so
the output is a deployable, no-build static site; ``fitsgl serve`` previews it.

Access goes through :mod:`importlib.resources` (not a hard-coded path) so it works
whether the package is installed unpacked or as a zip — :func:`copy_viewer_into`
uses :func:`importlib.resources.as_file`, which materializes a real directory in a
temp location on zip installs and is a no-op otherwise.
"""

from __future__ import annotations

import shutil
from importlib.resources import as_file, files
from pathlib import Path

#: Files that must exist for the bundle to be considered present/usable.
_REQUIRED = ("index.html",)


def viewer_available() -> bool:
    """Whether the vendored viewer bundle is present in this install."""
    root = files(__package__).joinpath("_viewer")
    return all(root.joinpath(name).is_file() for name in _REQUIRED)


def copy_viewer_into(dest: str | Path) -> None:
    """Copy the vendored viewer bundle's contents into ``dest`` (which must exist).

    ``index.html`` and ``assets/`` land directly in ``dest`` (beside the dataset's
    ``fitsgl.json``), overwriting any existing files. Raises ``FileNotFoundError``
    if the bundle was not vendored (e.g. an editable checkout that never ran
    ``npm run build-vendor``).
    """
    dest = Path(dest)
    if not viewer_available():
        raise FileNotFoundError(
            "the SSG viewer bundle is not vendored (pyramid_gen/_viewer is missing or "
            "incomplete); build it with `npm --prefix viewer run build-vendor`"
        )
    resource = files(__package__).joinpath("_viewer")
    with as_file(resource) as viewer_dir:
        shutil.copytree(viewer_dir, dest, dirs_exist_ok=True)
