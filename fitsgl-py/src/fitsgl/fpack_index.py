"""Byte-range addressing *inside* a supertile ``.fits.fz`` — no decode, no astropy.

A server cutout (issue #17) that has resolved which fpack tiles it needs (see
:mod:`fitsgl.tiles`) can range-read *just those tiles'* compressed bytes from R2
instead of pulling the whole supertile — the difference between a snappy
thumbnail and downloading ~100 MB. To do that it needs each tile's byte offset
and length within the file. Those live in the compressed BINTABLE's row table
(the heap descriptors), a few tens of KB at the front of the file.

This module is a faithful, dependency-free port of the TypeScript client's
``fpack/fits-header.ts`` + ``fpack/bintable.ts`` + the addressing half of
``fpack/fpack-file.ts``. It parses the primary + BINTABLE headers and the row
table with :mod:`struct` — no astropy, so a consumer gets byte ranges without
opening (or downloading) the image. It deliberately does **not** decompress: the
``.fits.fz`` files are standard fpacked FITS, so astropy (or a ported RICE
decoder) handles decode; this module is the addressing/geometry layer the issue
asks to make importable and stable.

Layout of an fpack BINTABLE data unit (see ``bintable.ts``)::

    [ primary HDU header ][ BINTABLE header ]
    [ fixed-width row table: NAXIS1 * NAXIS2 bytes ]   <- descriptors live here
    [ optional gap ]
    [ heap: PCOUNT bytes, starting THEAP from the data-unit start ]  <- tile bytes

Each row is one tile; its ``COMPRESSED_DATA`` cell is a variable-length-array
descriptor — ``(n_elements, byte_offset_into_heap)`` — so the tile's absolute
compressed bytes are ``[heap_start + heap_offset, +n_elements)``.
"""

from __future__ import annotations

import math
import struct
from dataclasses import dataclass
from typing import Callable, Optional

#: A range fetcher: return the bytes ``[start, end_inclusive]`` of the resource.
#: Mirrors the browser client's ``RangeFetcher`` (inclusive both ends, HTTP
#: ``Range: bytes=start-end`` semantics). The consumer binds this to its R2/HTTP
#: client (or a local file); everything here is fetcher-agnostic.
Fetcher = Callable[[int, int], bytes]

_CARD = 80
_BLOCK = 2880

#: Default first-read size on :meth:`SupertileIndex.open`. Sized to usually cover
#: the primary + BINTABLE headers in one request; the row table (which can be
#: larger for a many-tile supertile) is fetched in a second range read when it
#: does not fit. Matches the client's ``DEFAULT_INITIAL_BYTES``.
DEFAULT_INITIAL_BYTES = 32768

# Dither-method codes (mirror fpack/dither.ts). Reported by tile_params so a
# consumer that decodes RICE itself has the exact reversal parameters.
NO_DITHER = -1
SUBTRACTIVE_DITHER_1 = 1
SUBTRACTIVE_DITHER_2 = 2


class IncompleteHeaderError(Exception):
    """A FITS header had no ``END`` card in the bytes provided — fetch more and retry."""


def _dither_method_from_zquantiz(zquantiz: Optional[str]) -> int:
    if zquantiz == "SUBTRACTIVE_DITHER_1":
        return SUBTRACTIVE_DITHER_1
    if zquantiz == "SUBTRACTIVE_DITHER_2":
        return SUBTRACTIVE_DITHER_2
    return NO_DITHER


# --------------------------------------------------------------------------- #
# Minimal FITS header parsing (port of fits-header.ts)
# --------------------------------------------------------------------------- #
class _FitsHeader:
    """A parsed FITS header: keyword -> raw value field, plus the data-unit offset."""

    def __init__(self, values: dict[str, str], data_start: int) -> None:
        self._values = values
        #: Byte offset of the data unit / next HDU (one past END, 2880-aligned).
        self.data_start = data_start

    def _token(self, key: str) -> Optional[str]:
        raw = self._values.get(key)
        if raw is None:
            return None
        return raw.split("/", 1)[0].strip()

    def get_int(self, key: str) -> Optional[int]:
        tok = self._token(key)
        if not tok:
            return None
        try:
            return int(float(tok)) if ("." in tok or "e" in tok.lower()) else int(tok)
        except ValueError:
            return None

    def get_string(self, key: str) -> Optional[str]:
        raw = self._values.get(key)
        if raw is None:
            return None
        q = raw.find("'")
        if q == -1:
            tok = raw.split("/", 1)[0].strip()
            return tok or None
        # Parse a quoted string, handling '' escapes and trailing-space trimming.
        out: list[str] = []
        i = q + 1
        while i < len(raw):
            ch = raw[i]
            if ch == "'":
                if i + 1 < len(raw) and raw[i + 1] == "'":
                    out.append("'")
                    i += 2
                    continue
                break
            out.append(ch)
            i += 1
        return "".join(out).rstrip()

    def require_int(self, key: str) -> int:
        v = self.get_int(key)
        if v is None:
            raise ValueError(f"FITS header: required integer keyword {key} is missing")
        return v


def parse_fits_header(buf: bytes, start: int) -> _FitsHeader:
    """Parse a FITS header starting at byte ``start`` in ``buf``.

    Raises :class:`IncompleteHeaderError` if no ``END`` card is found before the
    buffer runs out — the caller should fetch more bytes and retry.
    """
    values: dict[str, str] = {}
    off = start
    while True:
        if off + _BLOCK > len(buf):
            raise IncompleteHeaderError(
                f"FITS header starting at byte {start} has no END card within the "
                f"available {len(buf)} bytes"
            )
        ended = False
        for i in range(0, _BLOCK, _CARD):
            card = buf[off + i : off + i + _CARD].decode("ascii", errors="replace")
            key = card[:8].strip()
            if key == "END":
                ended = True
                break
            # A value card has "= " in columns 9-10 (0-based 8-9). First wins.
            if key and card[8:10] == "= " and key not in values:
                values[key] = card[10:]
        off += _BLOCK
        if ended:
            break
    return _FitsHeader(values, off)


# --------------------------------------------------------------------------- #
# BINTABLE layout + variable-length descriptors (port of bintable.ts)
# --------------------------------------------------------------------------- #
_FIXED_SIZES = {"L": 1, "X": 1, "B": 1, "A": 1, "I": 2, "J": 4, "E": 4, "K": 8, "D": 8, "C": 8, "M": 16}


@dataclass(frozen=True)
class _ColumnDef:
    name: str
    tform: str
    offset: int  # byte offset within a row
    width: int  # byte width within a row
    kind: str  # "descriptor32" | "descriptor64" | "fixed"


@dataclass(frozen=True)
class _BinTableLayout:
    columns: list[_ColumnDef]
    by_name: dict[str, _ColumnDef]
    row_bytes: int  # NAXIS1
    n_rows: int  # NAXIS2
    theap: int
    pcount: int
    data_start: int
    heap_start: int  # data_start + theap

    @property
    def row_table_stop(self) -> int:
        """Absolute byte offset one past the fixed-width row table."""
        return self.data_start + self.row_bytes * self.n_rows


def _tform_byte_width(tform: str) -> tuple[int, str]:
    t = tform.strip()
    if "Q" in t:
        return 16, "descriptor64"  # 2 * int64
    if "P" in t:
        return 8, "descriptor32"  # 2 * int32
    i = 0
    while i < len(t) and t[i].isdigit():
        i += 1
    rep = int(t[:i]) if i > 0 else 1
    code = t[i : i + 1]
    size = _FIXED_SIZES.get(code)
    if size is None:
        raise ValueError(f"BINTABLE: unsupported TFORM code {code!r} in {tform!r}")
    return rep * size, "fixed"


def _parse_bintable_layout(header: _FitsHeader) -> _BinTableLayout:
    row_bytes = header.require_int("NAXIS1")
    n_rows = header.require_int("NAXIS2")
    pcount = header.get_int("PCOUNT") or 0
    tfields = header.require_int("TFIELDS")
    theap = header.get_int("THEAP")
    if theap is None:
        theap = row_bytes * n_rows
    data_start = header.data_start

    columns: list[_ColumnDef] = []
    by_name: dict[str, _ColumnDef] = {}
    offset = 0
    for i in range(1, tfields + 1):
        name = header.get_string(f"TTYPE{i}") or f"COL{i}"
        tform = header.get_string(f"TFORM{i}")
        if tform is None:
            raise ValueError(f"BINTABLE: missing TFORM{i}")
        width, kind = _tform_byte_width(tform)
        col = _ColumnDef(name=name, tform=tform, offset=offset, width=width, kind=kind)
        columns.append(col)
        by_name[name] = col
        offset += width
    if offset != row_bytes:
        raise ValueError(
            f"BINTABLE: sum of column widths ({offset}) does not equal NAXIS1 ({row_bytes})"
        )

    return _BinTableLayout(
        columns=columns,
        by_name=by_name,
        row_bytes=row_bytes,
        n_rows=n_rows,
        theap=theap,
        pcount=pcount,
        data_start=data_start,
        heap_start=data_start + theap,
    )


def _read_descriptor(buf: bytes, pos: int, kind: str) -> tuple[int, int]:
    """``(n_elements, heap_offset)`` from a variable-length-array descriptor at ``pos``."""
    if kind == "descriptor64":
        n, off = struct.unpack_from(">qq", buf, pos)
        return int(n), int(off)
    if kind == "descriptor32":
        n, off = struct.unpack_from(">ii", buf, pos)
        return int(n), int(off)
    raise ValueError(f"_read_descriptor: column kind {kind!r} is not a variable-length descriptor")


# --------------------------------------------------------------------------- #
# Public result types
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class ByteRange:
    """A byte range ``[start, start+length)``. Both HTTP-``Range`` and slice ready."""

    start: int
    length: int

    @property
    def stop(self) -> int:
        return self.start + self.length

    def http_range(self) -> str:
        """The value for an HTTP ``Range`` header (``bytes=start-endInclusive``)."""
        return f"bytes={self.start}-{self.stop - 1}"


@dataclass(frozen=True)
class TileParams:
    """Everything (besides the compressed bytes) needed to decode one fpack tile.

    Reported for completeness so a consumer that decodes RICE itself has the exact
    dequantization + dither-reversal parameters; the cutout service that hands the
    bytes to astropy can ignore it. Mirrors the client's ``TileDecodeParams``.
    """

    compression_type: str  # "RICE_1" | "GZIP_2"
    n_pixels: int  # width * height (partial edge tiles are smaller)
    block_size: int  # RICE ZBLOCKSIZE
    zscale: float  # per-tile quant scale (RICE); NaN for GZIP_2
    zzero: float
    zblank: float  # integer blank sentinel; NaN when none
    dither_method: int  # NO_DITHER | SUBTRACTIVE_DITHER_1 | _2
    zdither0: int  # ZDITHER0 seed
    tile_index: int  # 0-based row-major tile index = BINTABLE row = dither key


@dataclass(frozen=True)
class _TileEntry:
    n_bytes: int
    heap_offset: int
    zscale: float
    zzero: float
    zblank: float


_SUPPORTED_ZCMP = ("RICE_1", "GZIP_2")


class SupertileIndex:
    """The tile index of one supertile ``.fits.fz``: byte ranges + decode params.

    Construct with :meth:`open` (range-fetch the header + row table via a
    fetcher), :meth:`from_bytes` (you already hold the leading bytes), or
    :meth:`open_local` (a local file). Then call :meth:`tile_byte_range` /
    :meth:`tile_params` with *supertile-local* tile coordinates — the ones
    :func:`fitsgl.tiles.resolve_supertile` returns.

    Only metadata is parsed; the compressed heap bytes are never read here.
    """

    def __init__(self, head: _FitsHeader, bintable: _FitsHeader, layout: _BinTableLayout, row_table: bytes) -> None:
        self.compression_type = bintable.get_string("ZCMPTYPE")
        if self.compression_type not in _SUPPORTED_ZCMP:
            raise ValueError(
                f"unsupported ZCMPTYPE {self.compression_type!r}; only RICE_1 and GZIP_2 are supported"
            )
        self._layout = layout

        self.znaxis1 = bintable.require_int("ZNAXIS1")  # columns (fast axis)
        self.znaxis2 = bintable.require_int("ZNAXIS2")  # rows (slow axis)
        self.ztile1 = bintable.get_int("ZTILE1") or self.znaxis1
        self.ztile2 = bintable.get_int("ZTILE2") or 1
        self.block_size = bintable.get_int("ZBLOCKSIZE") or 32
        self.dither_method = _dither_method_from_zquantiz(bintable.get_string("ZQUANTIZ"))
        self.zdither0 = bintable.get_int("ZDITHER0") or 0
        zblank_header = bintable.get_int("ZBLANK")
        self._zblank_header = float("nan") if zblank_header is None else float(zblank_header)

        self.n_tiles_x = math.ceil(self.znaxis1 / self.ztile1)
        self.n_tiles_y = math.ceil(self.znaxis2 / self.ztile2)

        expected_rows = self.n_tiles_x * self.n_tiles_y
        if layout.n_rows != expected_rows:
            raise ValueError(
                f"BINTABLE has {layout.n_rows} rows but the tile grid is "
                f"{self.n_tiles_x}x{self.n_tiles_y} = {expected_rows}"
            )

        self._entries = self._parse_entries(layout, row_table)

    # -- constructors -------------------------------------------------------- #
    @classmethod
    def from_bytes(cls, buf: bytes) -> "SupertileIndex":
        """Parse from a leading-bytes buffer that already covers the row table.

        Raises :class:`IncompleteHeaderError` if the buffer stops before the
        headers or row table are complete (use :meth:`open` to fetch more).
        """
        primary = parse_fits_header(buf, 0)
        bintable = parse_fits_header(buf, primary.data_start)
        layout = _parse_bintable_layout(bintable)
        if len(buf) < layout.row_table_stop:
            raise IncompleteHeaderError(
                f"buffer of {len(buf)} bytes does not cover the row table "
                f"(needs {layout.row_table_stop}); fetch more bytes"
            )
        row_table = buf[layout.data_start : layout.row_table_stop]
        return cls(primary, bintable, layout, row_table)

    @classmethod
    def open(cls, fetch: Fetcher, *, initial_bytes: int = DEFAULT_INITIAL_BYTES) -> "SupertileIndex":
        """Range-fetch and parse the tile index using ``fetch(start, end_inclusive)``.

        Reads ``initial_bytes`` first (grows the window if the headers do not fit),
        parses the primary + BINTABLE headers, then reads the row table in one
        more range request when it is not already covered. At most a couple of
        round trips regardless of supertile size, and the compressed heap is never
        touched.
        """
        requested = initial_bytes
        head = fetch(0, requested - 1)
        primary = None
        bintable = None
        for attempt in range(6):
            try:
                primary = parse_fits_header(head, 0)
                bintable = parse_fits_header(head, primary.data_start)
                break
            except IncompleteHeaderError:
                if attempt >= 5:
                    raise
                prev_len = len(head)
                requested *= 4
                head = fetch(0, requested - 1)
                if len(head) <= prev_len:
                    raise  # whole file read, still no END -> malformed
        assert primary is not None and bintable is not None
        layout = _parse_bintable_layout(bintable)
        if len(head) >= layout.row_table_stop:
            row_table = head[layout.data_start : layout.row_table_stop]
        else:
            row_table = fetch(layout.data_start, layout.row_table_stop - 1)
            if len(row_table) < layout.row_bytes * layout.n_rows:
                raise ValueError(
                    f"fetched {len(row_table)} row-table bytes, expected "
                    f"{layout.row_bytes * layout.n_rows}"
                )
        return cls(primary, bintable, layout, row_table)

    @classmethod
    def open_local(cls, path: str, *, initial_bytes: int = DEFAULT_INITIAL_BYTES) -> "SupertileIndex":
        """Parse the tile index of a supertile on the local filesystem (reads only the
        leading header + row-table bytes, never the whole file)."""
        with open(path, "rb") as f:

            def fetch(start: int, end_inclusive: int) -> bytes:
                f.seek(start)
                return f.read(end_inclusive - start + 1)

            return cls.open(fetch, initial_bytes=initial_bytes)

    # -- internals ----------------------------------------------------------- #
    def _parse_entries(self, layout: _BinTableLayout, row_table: bytes) -> list[_TileEntry]:
        cd = layout.by_name.get("COMPRESSED_DATA")
        if cd is None:
            raise ValueError("BINTABLE has no COMPRESSED_DATA column")
        gzip_col = layout.by_name.get("GZIP_COMPRESSED_DATA")
        zscale_col = layout.by_name.get("ZSCALE")
        zzero_col = layout.by_name.get("ZZERO")
        zblank_col = layout.by_name.get("ZBLANK")

        entries: list[_TileEntry] = []
        for r in range(layout.n_rows):
            row_off = r * layout.row_bytes
            n_bytes, heap_off = _read_descriptor(row_table, row_off + cd.offset, cd.kind)
            gzip_n = 0
            if gzip_col is not None:
                gzip_n, _ = _read_descriptor(row_table, row_off + gzip_col.offset, gzip_col.kind)
            # A non-empty COMPRESSED_DATA with an also-non-empty GZIP fallback is a
            # per-tile lossless fallback; flag empties at range time, not here.
            zscale = (
                struct.unpack_from(">d", row_table, row_off + zscale_col.offset)[0]
                if zscale_col is not None
                else float("nan")
            )
            zzero = (
                struct.unpack_from(">d", row_table, row_off + zzero_col.offset)[0]
                if zzero_col is not None
                else float("nan")
            )
            if zblank_col is not None:
                zblank = float(struct.unpack_from(">i", row_table, row_off + zblank_col.offset)[0])
            else:
                zblank = self._zblank_header
            entries.append(
                _TileEntry(
                    n_bytes=n_bytes,
                    heap_offset=heap_off,
                    zscale=zscale,
                    zzero=zzero,
                    zblank=zblank,
                )
            )
        return entries

    def _check_coords(self, local_x: int, local_y: int) -> int:
        if not (0 <= local_x < self.n_tiles_x and 0 <= local_y < self.n_tiles_y):
            raise IndexError(
                f"tile ({local_x}, {local_y}) is out of range for a "
                f"{self.n_tiles_x}x{self.n_tiles_y} supertile grid"
            )
        return local_y * self.n_tiles_x + local_x

    # -- public queries ------------------------------------------------------ #
    def tile_row(self, local_x: int, local_y: int) -> int:
        """The 0-based row-major BINTABLE row index of a supertile-local tile."""
        return self._check_coords(local_x, local_y)

    def tile_dims(self, local_x: int, local_y: int) -> tuple[int, int]:
        """``(width, height)`` in pixels of a supertile-local tile (partial edges shrink)."""
        self._check_coords(local_x, local_y)
        width = min(self.ztile1, self.znaxis1 - local_x * self.ztile1)
        height = min(self.ztile2, self.znaxis2 - local_y * self.ztile2)
        return width, height

    def tile_byte_range(self, local_x: int, local_y: int) -> ByteRange:
        """Absolute byte range of a tile's compressed heap bytes — range-read this from R2.

        Raises :class:`ValueError` for a tile with empty ``COMPRESSED_DATA`` (a
        pyramid level never has one; only a per-tile GZIP fallback would, which
        this display pipeline does not emit).
        """
        row = self._check_coords(local_x, local_y)
        entry = self._entries[row]
        if entry.n_bytes == 0:
            raise ValueError(
                f"tile ({local_x}, {local_y}) has empty COMPRESSED_DATA — not a "
                "range-readable RICE/GZIP tile (unexpected for a fitsgl pyramid)"
            )
        return ByteRange(start=self._layout.heap_start + entry.heap_offset, length=entry.n_bytes)

    def tile_params(self, local_x: int, local_y: int) -> TileParams:
        """Decode parameters for a supertile-local tile (see :class:`TileParams`)."""
        row = self._check_coords(local_x, local_y)
        entry = self._entries[row]
        width, height = self.tile_dims(local_x, local_y)
        assert self.compression_type is not None
        return TileParams(
            compression_type=self.compression_type,
            n_pixels=width * height,
            block_size=self.block_size,
            zscale=entry.zscale,
            zzero=entry.zzero,
            zblank=entry.zblank,
            dither_method=self.dither_method,
            zdither0=self.zdither0,
            tile_index=row,
        )


def coalesce_ranges(ranges: list[ByteRange], *, max_gap: int = 0) -> list[ByteRange]:
    """Merge overlapping / near-adjacent byte ranges to cut round trips.

    Sorts by start and unions any two ranges whose gap is ``<= max_gap`` bytes
    (``max_gap=0`` merges only touching/overlapping ranges). A cutout's covering
    tiles are laid out roughly contiguously in the heap, so coalescing turns a
    grid of tiny tile reads into a handful of larger ones — the consumer slices
    each tile back out of the returned blob by offset. Returns a new,
    start-sorted list.
    """
    if not ranges:
        return []
    ordered = sorted(ranges, key=lambda r: r.start)
    merged: list[ByteRange] = [ordered[0]]
    for r in ordered[1:]:
        last = merged[-1]
        if r.start <= last.stop + max_gap:
            new_stop = max(last.stop, r.stop)
            merged[-1] = ByteRange(start=last.start, length=new_stop - last.start)
        else:
            merged.append(r)
    return merged
