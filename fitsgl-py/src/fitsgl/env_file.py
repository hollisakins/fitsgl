"""Minimal ``.env`` reader for ``fitsgl deploy`` credentials.

``fitsgl deploy`` finds its R2/Cloudflare secrets in the *process environment*
(``R2_ACCESS_KEY_ID`` / ``R2_SECRET_ACCESS_KEY`` / ``CLOUDFLARE_API_TOKEN`` — see
``deploy.py``). As a convenience, the CLI also reads a ``.env`` file sitting next
to the ``fitsgl.toml`` and loads any ``KEY=value`` pairs it finds, so a producer
can keep their secrets in one (git-ignored) file instead of re-exporting them
each shell.

Deliberately tiny and dependency-free (the package ships no ``python-dotenv``):
it covers the cases a credentials file needs — ``KEY=value``, an optional
``export`` prefix, ``#`` comments (whole-line and trailing), surrounding quotes,
and blank lines — and nothing more. **A real environment variable always wins**
over the file (``override=False``), so a value exported in the shell or injected
by a CI secret store is never silently shadowed by a stale ``.env``.

The pure :func:`parse_env_file` (text → dict) is split from :func:`load_env_file`
(the ``os.environ`` side effect) so the parsing is unit-testable without touching
global state.
"""

from __future__ import annotations

import os
from pathlib import Path

__all__ = ["parse_env_file", "load_env_file"]


def _strip_inline_comment(value: str) -> str:
    """Drop a trailing ``#`` comment from an *unquoted* value.

    A ``#`` starts a comment only at the start of the value or after whitespace
    (so ``token#frag`` stays intact, but ``token  # note`` becomes ``token``)."""
    for i, ch in enumerate(value):
        if ch == "#" and (i == 0 or value[i - 1].isspace()):
            return value[:i].strip()
    return value.strip()


def _parse_value(rest: str) -> str:
    """Parse the right-hand side of a ``KEY=`` line into its string value."""
    v = rest.strip()
    if not v:
        return ""
    quote = v[0]
    if quote in ('"', "'"):
        end = v.find(quote, 1)
        if end != -1:
            return v[1:end]  # quoted: take the literal content, ignore any trailing comment
        return v[1:]  # unterminated quote — take the remainder literally
    return _strip_inline_comment(v)


def parse_env_file(text: str) -> dict[str, str]:
    """Parse ``.env`` *text* into an ordered ``{KEY: value}`` mapping.

    Lines that are blank, whole-line comments, or lack an ``=`` are skipped; a
    leading ``export`` is stripped; later assignments to the same key win.
    """
    result: dict[str, str] = {}
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export") and line[6:7].isspace():
            line = line[6:].lstrip()
        if "=" not in line:
            continue  # not a KEY=value assignment — ignore
        key, _, rest = line.partition("=")
        key = key.strip()
        if not key or any(c.isspace() for c in key):
            continue  # a key with spaces is malformed — skip rather than guess
        result[key] = _parse_value(rest)
    return result


def load_env_file(path: str | Path, *, override: bool = False) -> list[str]:
    """Load ``KEY=value`` pairs from the ``.env`` at *path* into ``os.environ``.

    Returns the keys actually applied, in file order. A missing file is a no-op
    (returns ``[]``) — credentials may legitimately come straight from the
    environment. Unless ``override`` is set, a key already present in the
    environment is left untouched (and omitted from the result), so the real
    environment always takes precedence over the file. May raise ``OSError`` if
    the file exists but cannot be read.
    """
    path = Path(path)
    if not path.is_file():
        return []
    values = parse_env_file(path.read_text(encoding="utf-8"))
    applied: list[str] = []
    for key, value in values.items():
        if override or key not in os.environ:
            os.environ[key] = value
            applied.append(key)
    return applied
