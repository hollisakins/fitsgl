"""``fitsgl serve`` — a local HTTP server with byte-accurate Range support.

A producer runs this against a built dataset directory to verify it *before*
deploying: the single biggest deploy footgun is a host that ignores ``Range`` (the
client's ``httpRangeFetch`` hard-rejects a ``200`` to a ranged request), so this
mirrors the demo's Vite Range middleware (``demo/vite.config.ts``) byte-for-byte —
"looks right locally → looks right on the CDN."

Python stdlib only (no Node), so ``fitsgl`` stays a single ``pip install``. The
Range math is a pure function (``resolve_range``) split from the socket I/O.
"""

from __future__ import annotations

import http.server
import json
import os
import re
import socketserver
import sys
from pathlib import Path

_RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")
_CHUNK = 64 * 1024

#: Static MIME types. Beyond the dataset's data/metadata this must cover the
#: bundled viewer's assets — notably ``.js``: a ``<script type="module">`` is
#: BLOCKED by browsers unless the script is served with a JavaScript MIME type.
_CONTENT_TYPES = {
    ".json": "application/json",
    ".csv": "text/csv",
    ".html": "text/html",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".map": "application/json",
    ".svg": "image/svg+xml",
    ".wasm": "application/wasm",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ico": "image/x-icon",
    ".txt": "text/plain",
}


def content_type_for(name: str) -> str:
    """MIME type by extension (the tile ``.fits.fz`` and unknowns are octet-stream)."""
    low = name.lower()
    if low.endswith(".fits.fz"):
        return "application/octet-stream"
    return _CONTENT_TYPES.get(os.path.splitext(low)[1], "application/octet-stream")


def make_etag(size: int, mtime: float) -> str:
    """``"<sizeHex>-<mtimeMsHex>"`` — same formula as the demo's ETag."""
    return f'"{size:x}-{round(mtime * 1000):x}"'


def resolve_range(range_header: str | None, size: int) -> tuple[str, int, int]:
    """Resolve a ``Range`` header against a file ``size``.

    Returns ``(kind, start, end)`` with ``end`` INCLUSIVE:
      - ``("full", 0, size-1)`` — no/absent Range → serve the whole file (200).
      - ``("range", start, end)`` — a satisfiable range → 206.
      - ``("unsatisfiable", -1, -1)`` — malformed or out of range → 416.

    Mirrors ``demo/vite.config.ts`` branch-for-branch: closed ``a-b``, open-ended
    ``a-``, suffix ``-N``; rejects ``bytes=-``; ``start>end`` or ``start>=size`` is
    unsatisfiable; ``end`` is clamped to ``size-1``.
    """
    if range_header is None:
        return ("full", 0, size - 1)
    m = _RANGE_RE.match(range_header.strip())
    if m is None or (m.group(1) == "" and m.group(2) == ""):
        return ("unsatisfiable", -1, -1)
    if m.group(1) == "":  # suffix range: bytes=-N -> last N bytes
        n = int(m.group(2))
        start = max(0, size - n)
        end = size - 1
    else:
        start = int(m.group(1))
        end = size - 1 if m.group(2) == "" else int(m.group(2))
    if start > end or start >= size:
        return ("unsatisfiable", -1, -1)
    return ("range", start, min(end, size - 1))


class FitsglRangeHandler(http.server.BaseHTTPRequestHandler):
    """Serves ``served_root`` with Range/206, ETag/304, and traversal guards.

    A per-serve subclass binds ``served_root`` (set by :func:`serve`).
    """

    protocol_version = "HTTP/1.1"
    served_root: Path  # bound on the per-serve subclass

    def do_GET(self) -> None:
        self._serve(write_body=True)

    def do_HEAD(self) -> None:
        self._serve(write_body=False)

    def do_OPTIONS(self) -> None:
        # CORS preflight: browsers preflight a cross-origin ranged fetch (the `Range`
        # header isn't "simple"), so an external viewer can consume a served dataset.
        self.send_response(204)
        self.send_header("Allow", "GET, HEAD, OPTIONS")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Range, If-None-Match")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def end_headers(self) -> None:
        # Inject permissive CORS on every response so a viewer hosted elsewhere can
        # fetch the dataset (and read the range/validation headers it needs).
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, ETag, Content-Length")
        super().end_headers()

    def log_message(self, *args: object) -> None:  # keep the console clean
        pass

    def _resolve(self) -> tuple[Path | None, tuple[int, str] | None]:
        """Map the request path to a contained, existing file, or an error.

        Lexical containment then realpath/symlink containment (both must stay under
        the served root), mirroring ``demo/vite.config.ts``. Returns ``(path, None)``
        or ``(None, (status, message))``.
        """
        from urllib.parse import unquote, urlsplit

        rel = unquote(urlsplit(self.path).path).lstrip("/")
        root = os.path.normpath(str(self.served_root))
        norm = os.path.normpath(os.path.join(root, rel))
        if norm != root and not norm.startswith(root + os.sep):
            return (None, (403, "Forbidden"))
        real_root = os.path.realpath(self.served_root)
        real = os.path.realpath(norm)
        if real != real_root and not real.startswith(real_root + os.sep):
            return (None, (403, "Forbidden"))
        if not os.path.isfile(real):
            # A directory ('/' or a subdir) serves its index.html (the SSG entry),
            # re-validating containment of the resolved index file.
            if os.path.isdir(real):
                index = os.path.realpath(os.path.join(real, "index.html"))
                if (index == real_root or index.startswith(real_root + os.sep)) and os.path.isfile(index):
                    return (Path(index), None)
            return (None, (404, "Not found"))
        return (Path(real), None)

    def _send_error_body(self, code: int, message: str, write_body: bool) -> None:
        body = message.encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if write_body:
            self.wfile.write(body)

    def _serve(self, write_body: bool) -> None:
        path, err = self._resolve()
        if err is not None:
            self._send_error_body(err[0], err[1], write_body)
            return
        assert path is not None
        st = path.stat()
        size = st.st_size
        etag = make_etag(size, st.st_mtime)

        # Conditional revalidation comes before Range (matches the demo ordering).
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        kind, start, end = resolve_range(self.headers.get("Range"), size)
        if kind == "unsatisfiable":
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        if kind == "full":
            self.send_response(200)
            length = size
            offset = 0
        else:  # range
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            length = end - start + 1
            offset = start
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Type", content_type_for(path.name))
        self.send_header("ETag", etag)
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if write_body:
            self._stream(path, offset, length)

    def _stream(self, path: Path, offset: int, length: int) -> None:
        with open(path, "rb") as f:
            f.seek(offset)
            remaining = length
            while remaining > 0:
                buf = f.read(min(_CHUNK, remaining))
                if not buf:
                    break
                self.wfile.write(buf)
                remaining -= len(buf)


class _ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def serve(dataset_dir: str | Path, port: int = 8000, host: str = "127.0.0.1") -> int:
    """Serve ``dataset_dir`` over HTTP with Range support until interrupted.

    Binds to localhost. Warns (does not fail) if ``fitsgl.json`` is absent — a
    partially-built directory is fine to preview. ``port=0`` picks an ephemeral
    port (used by tests). Returns 0 on a clean Ctrl-C.
    """
    dataset_dir = Path(dataset_dir)
    if not dataset_dir.is_dir():
        raise FileNotFoundError(f"not a directory: {dataset_dir}")
    root = dataset_dir.resolve()

    name = root.name
    config_path = root / "fitsgl.json"
    if config_path.is_file():
        try:
            name = json.loads(config_path.read_text()).get("dataset", {}).get("name", name)
        except (ValueError, OSError):
            pass
    else:
        print(f"fitsgl serve: warning: no fitsgl.json in {root} (serving anyway)", file=sys.stderr)

    handler = type("FitsglRangeHandlerBound", (FitsglRangeHandler,), {"served_root": root})
    httpd = _ThreadingHTTPServer((host, port), handler)
    actual_port = httpd.server_address[1]
    print(f"fitsgl serve: dataset {name!r} at http://{host}:{actual_port}/  (Ctrl-C to stop)")
    if config_path.is_file():
        print(f"  config: http://{host}:{actual_port}/fitsgl.json")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print()
    finally:
        httpd.server_close()
    return 0
