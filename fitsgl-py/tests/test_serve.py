"""Tests for `fitsgl serve` (serve.py): the pure Range resolver + a live server."""

import http.client
import os
import sys
import threading

import pytest

from fitsgl.serve import (
    FitsglRangeHandler,
    _ThreadingHTTPServer,
    content_type_for,
    make_etag,
    resolve_range,
)


# ---- pure resolver ----------------------------------------------------------


@pytest.mark.parametrize(
    "header,size,expected",
    [
        (None, 100, ("full", 0, 99)),
        ("bytes=0-9", 100, ("range", 0, 9)),
        ("bytes=0-0", 100, ("range", 0, 0)),
        ("bytes=10-", 100, ("range", 10, 99)),  # open-ended
        ("bytes=-20", 100, ("range", 80, 99)),  # suffix
        ("bytes=90-999", 100, ("range", 90, 99)),  # end clamped to size-1
        ("bytes=-999", 100, ("range", 0, 99)),  # suffix larger than file
        (" bytes=0-9 ", 100, ("range", 0, 9)),  # whitespace tolerated
        ("bytes=-", 100, ("unsatisfiable", -1, -1)),  # both empty
        ("bytes=200-", 100, ("unsatisfiable", -1, -1)),  # start >= size
        ("bytes=5-1", 100, ("unsatisfiable", -1, -1)),  # start > end
        ("bytes=abc", 100, ("unsatisfiable", -1, -1)),  # malformed
        ("not-a-range", 100, ("unsatisfiable", -1, -1)),
        ("bytes=0-", 0, ("unsatisfiable", -1, -1)),  # empty file
    ],
)
def test_resolve_range(header, size, expected):
    assert resolve_range(header, size) == expected


def test_make_etag_formula():
    assert make_etag(255, 0.0) == '"ff-0"'
    assert make_etag(16, 1.0) == '"10-3e8"'  # 16 -> 10 hex; 1.0s -> 1000ms -> 3e8 hex


def test_content_type_for():
    assert content_type_for("f444w_z0.fits.fz") == "application/octet-stream"
    assert content_type_for("manifest.json") == "application/json"
    assert content_type_for("catalog.csv") == "text/csv"
    assert content_type_for("index.html") == "text/html"
    assert content_type_for("index-abc123.js") == "text/javascript"  # module scripts need a JS MIME
    assert content_type_for("index-abc123.css") == "text/css"
    assert content_type_for("mystery.bin") == "application/octet-stream"


# ---- live server integration -----------------------------------------------

TILE = bytes(range(256)) * 4  # 1024 deterministic bytes


@pytest.fixture
def server(tmp_path):
    root = tmp_path / "ds"
    root.mkdir()
    (root / "tile.fits.fz").write_bytes(TILE)
    (root / "fitsgl.json").write_text('{"schemaVersion": 1}\n')
    (root / "index.html").write_text("<!doctype html><title>FitsGL</title>")
    handler = type("Bound", (FitsglRangeHandler,), {"served_root": root.resolve()})
    httpd = _ThreadingHTTPServer(("127.0.0.1", 0), handler)
    port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield port, root
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=5)


def _request(port, method, path, headers=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        conn.request(method, path, headers=headers or {})
        resp = conn.getresponse()
        body = resp.read()
        return resp.status, dict(resp.getheaders()), body
    finally:
        conn.close()


def test_ranged_tile_returns_206(server):
    port, _ = server
    status, headers, body = _request(port, "GET", "/tile.fits.fz", {"Range": "bytes=0-9"})
    assert status == 206
    assert headers["Content-Range"] == "bytes 0-9/1024"
    assert headers["Content-Length"] == "10"
    assert headers["Accept-Ranges"] == "bytes"
    assert body == TILE[0:10]


def test_suffix_range(server):
    port, _ = server
    status, headers, body = _request(port, "GET", "/tile.fits.fz", {"Range": "bytes=-5"})
    assert status == 206
    assert headers["Content-Range"] == "bytes 1019-1023/1024"
    assert body == TILE[-5:]


def test_unranged_metadata_is_200(server):
    port, _ = server
    status, headers, body = _request(port, "GET", "/fitsgl.json")
    assert status == 200
    assert headers["Content-Type"] == "application/json"
    assert headers["Content-Length"] == str(len(body))
    assert b'"schemaVersion": 1' in body


def test_root_serves_index_html(server):
    port, _ = server
    status, headers, body = _request(port, "GET", "/")
    assert status == 200
    assert headers["Content-Type"] == "text/html"
    assert b"FitsGL" in body


def test_cors_headers_on_every_response(server):
    port, _ = server
    _, headers, _ = _request(port, "GET", "/tile.fits.fz")
    assert headers["Access-Control-Allow-Origin"] == "*"
    assert "Content-Range" in headers["Access-Control-Expose-Headers"]


def test_options_preflight_is_204(server):
    port, _ = server
    status, headers, body = _request(port, "OPTIONS", "/tile.fits.fz")
    assert status == 204
    assert "GET" in headers["Access-Control-Allow-Methods"]
    assert "Range" in headers["Access-Control-Allow-Headers"]
    assert headers["Access-Control-Allow-Origin"] == "*"
    assert body == b""


def test_unsatisfiable_range_is_416(server):
    port, _ = server
    status, headers, _ = _request(port, "GET", "/tile.fits.fz", {"Range": "bytes=99999-"})
    assert status == 416
    assert headers["Content-Range"] == "bytes */1024"


def test_conditional_304(server):
    port, _ = server
    _, headers, _ = _request(port, "GET", "/tile.fits.fz")
    etag = headers["ETag"]
    status, _, body = _request(port, "GET", "/tile.fits.fz", {"If-None-Match": etag})
    assert status == 304
    assert body == b""


def test_head_ranged_has_headers_no_body(server):
    port, _ = server
    status, headers, body = _request(port, "HEAD", "/tile.fits.fz", {"Range": "bytes=0-9"})
    assert status == 206
    assert headers["Content-Length"] == "10"
    assert body == b""


def test_traversal_and_missing(server):
    port, _ = server
    assert _request(port, "GET", "/../../etc/passwd")[0] == 403
    assert _request(port, "GET", "/%2e%2e/%2e%2e/etc/passwd")[0] == 403
    assert _request(port, "GET", "/nope.json")[0] == 404


@pytest.mark.skipif(sys.platform == "win32", reason="symlink semantics differ on Windows")
def test_symlink_escape_forbidden(server, tmp_path):
    port, root = server
    secret = tmp_path / "secret.txt"
    secret.write_text("nope")
    (root / "link").symlink_to(tmp_path)  # points outside the served root
    assert _request(port, "GET", "/link/secret.txt")[0] == 403
