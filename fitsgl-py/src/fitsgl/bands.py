"""Astronomical filter/band detection from a FITS header (HST + JWST).

Pure logic, no file I/O: :func:`detect_band` takes an ``astropy`` ``fits.Header``
and returns a :class:`DetectedBand` (canonical filter, instrument, telescope, a
pivot wavelength for ordering, and whether it is a broadband) — or ``None`` when
the header is not a recognized HST/JWST imaging band, so the caller can fall back
to filename-derived naming.

:func:`detect_band_from_filename` is the lower-confidence companion for the common
case of a community-built mosaic whose science extension keeps only WCS (no
``INSTRUME``/``FILTER``): it recovers the same :class:`DetectedBand` from a filter
token embedded in the *filename* (e.g. ``..._f090w_...``). Callers try the header
first and fall back to it.

Scope is intentionally narrow for v1: HST (ACS, WFC3/UVIS, WFC3/IR) and JWST
(NIRCam, NIRISS, MIRI imaging). ``fitsgl init`` uses this to label bands by filter
(``F444W`` rather than the filename) and to auto-pick a default RGB view; nothing
here reads pixels or touches the build.

Pivot wavelengths come from a curated table (:data:`PIVOT_UM`, the source of
truth, from the STScI instrument handbooks / JDox). For a filter not yet in the
table, :func:`_parse_pivot` recovers an *ordering-only* estimate from the filter
number using each instrument's unit convention — see the WFC3/IR note there.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from astropy.io import fits

#: A filter token: ``F`` + 3–4 digits + an optional width suffix (``W``/``M``/``N``/
#: ``X``), the NIRCam wide-blocker form (``W2``), or HST long-pass (``LP``).
_FILTER_RE = re.compile(r"^F\d{3,4}(?:W2|LP|[WMNX])?$")

#: JWST instruments handled here (others — NIRSpec, FGS — are not imaging bands).
_JWST_INSTRUMENTS = {"NIRCAM": "NIRCam", "NIRISS": "NIRISS", "MIRI": "MIRI"}
#: HST instruments handled here.
_HST_INSTRUMENTS = {"ACS": "ACS", "WFC3": "WFC3"}

#: Curated pivot wavelengths (microns), keyed by (lookup-key, filter). The lookup
#: key is the instrument, except WFC3 which splits into "WFC3/UVIS" and "WFC3/IR"
#: (their filter-number conventions differ — see _parse_pivot). Values are the
#: published pivot wavelengths from the STScI handbooks; only the relative order
#: matters for the RGB auto-pick, so small revisions are harmless.
PIVOT_UM: dict[tuple[str, str], float] = {
    # --- JWST NIRCam (JDox) ---
    ("NIRCAM", "F070W"): 0.704,
    ("NIRCAM", "F090W"): 0.902,
    ("NIRCAM", "F115W"): 1.154,
    ("NIRCAM", "F140M"): 1.404,
    ("NIRCAM", "F150W"): 1.501,
    ("NIRCAM", "F150W2"): 1.659,
    ("NIRCAM", "F162M"): 1.626,
    ("NIRCAM", "F164N"): 1.645,
    ("NIRCAM", "F182M"): 1.845,
    ("NIRCAM", "F187N"): 1.874,
    ("NIRCAM", "F200W"): 1.990,
    ("NIRCAM", "F210M"): 2.093,
    ("NIRCAM", "F212N"): 2.120,
    ("NIRCAM", "F250M"): 2.503,
    ("NIRCAM", "F277W"): 2.786,
    ("NIRCAM", "F300M"): 2.996,
    ("NIRCAM", "F322W2"): 3.232,
    ("NIRCAM", "F323N"): 3.237,
    ("NIRCAM", "F335M"): 3.365,
    ("NIRCAM", "F356W"): 3.563,
    ("NIRCAM", "F360M"): 3.621,
    ("NIRCAM", "F405N"): 4.055,
    ("NIRCAM", "F410M"): 4.092,
    ("NIRCAM", "F430M"): 4.280,
    ("NIRCAM", "F444W"): 4.421,
    ("NIRCAM", "F460M"): 4.624,
    ("NIRCAM", "F466N"): 4.654,
    ("NIRCAM", "F470N"): 4.707,
    ("NIRCAM", "F480M"): 4.834,
    # --- JWST NIRISS ---
    ("NIRISS", "F090W"): 0.901,
    ("NIRISS", "F115W"): 1.150,
    ("NIRISS", "F140M"): 1.404,
    ("NIRISS", "F150W"): 1.493,
    ("NIRISS", "F158M"): 1.587,
    ("NIRISS", "F200W"): 1.972,
    ("NIRISS", "F277W"): 2.776,
    ("NIRISS", "F356W"): 3.563,
    ("NIRISS", "F380M"): 3.826,
    ("NIRISS", "F430M"): 4.286,
    ("NIRISS", "F444W"): 4.408,
    ("NIRISS", "F480M"): 4.815,
    # --- JWST MIRI (imaging) ---
    ("MIRI", "F560W"): 5.6,
    ("MIRI", "F770W"): 7.7,
    ("MIRI", "F1000W"): 10.0,
    ("MIRI", "F1130W"): 11.3,
    ("MIRI", "F1280W"): 12.8,
    ("MIRI", "F1500W"): 15.0,
    ("MIRI", "F1800W"): 18.0,
    ("MIRI", "F2100W"): 21.0,
    ("MIRI", "F2550W"): 25.5,
    # --- HST ACS/WFC ---
    ("ACS", "F435W"): 0.4329,
    ("ACS", "F475W"): 0.4747,
    ("ACS", "F502N"): 0.5023,
    ("ACS", "F550M"): 0.5581,
    ("ACS", "F555W"): 0.5361,
    ("ACS", "F606W"): 0.5907,
    ("ACS", "F625W"): 0.6311,
    ("ACS", "F658N"): 0.6584,
    ("ACS", "F660N"): 0.6599,
    ("ACS", "F775W"): 0.7693,
    ("ACS", "F814W"): 0.8057,
    ("ACS", "F850LP"): 0.9033,
    # --- HST WFC3/UVIS ---
    ("WFC3/UVIS", "F218W"): 0.2228,
    ("WFC3/UVIS", "F225W"): 0.2372,
    ("WFC3/UVIS", "F275W"): 0.2710,
    ("WFC3/UVIS", "F336W"): 0.3355,
    ("WFC3/UVIS", "F390W"): 0.3924,
    ("WFC3/UVIS", "F438W"): 0.4326,
    ("WFC3/UVIS", "F475W"): 0.4773,
    ("WFC3/UVIS", "F555W"): 0.5308,
    ("WFC3/UVIS", "F606W"): 0.5887,
    ("WFC3/UVIS", "F625W"): 0.6242,
    ("WFC3/UVIS", "F775W"): 0.7651,
    ("WFC3/UVIS", "F814W"): 0.8039,
    ("WFC3/UVIS", "F850LP"): 0.9176,
    # --- HST WFC3/IR ---
    ("WFC3/IR", "F098M"): 0.9864,
    ("WFC3/IR", "F105W"): 1.0552,
    ("WFC3/IR", "F110W"): 1.1534,
    ("WFC3/IR", "F125W"): 1.2486,
    ("WFC3/IR", "F127M"): 1.2740,
    ("WFC3/IR", "F139M"): 1.3838,
    ("WFC3/IR", "F140W"): 1.3923,
    ("WFC3/IR", "F153M"): 1.5322,
    ("WFC3/IR", "F160W"): 1.5369,
}


@dataclass(frozen=True)
class DetectedBand:
    """One band's identity, derived from an HST/JWST imaging header."""

    filter: str  # canonical filter token, uppercased, e.g. "F444W"
    instrument: str  # "NIRCam" | "NIRISS" | "MIRI" | "ACS" | "WFC3"
    telescope: str  # "JWST" | "HST"
    pivot_um: float  # pivot wavelength (microns) — for wavelength ordering
    is_broadband: bool  # True for wide ("W"/"W2") filters — the RGB candidates


def _get(header: fits.Header, key: str) -> str:
    """Header value as an uppercased, stripped string ('' if missing/non-string)."""
    v = header.get(key)
    return str(v).strip().upper() if isinstance(v, str) else ""


def _is_filter_token(tok: str) -> bool:
    return bool(_FILTER_RE.match(tok))


def _is_clearish(tok: str) -> bool:
    """An empty / CLEAR* element (a blocking position, not a science filter)."""
    return tok == "" or tok.startswith("CLEAR")


def _is_broadband(filt: str) -> bool:
    """Wide filters end in ``W`` (or ``W2`` for NIRCam wide blockers)."""
    return filt.endswith("W") or filt.endswith("W2")


def _identify(header: fits.Header) -> tuple[str, str] | None:
    """``(telescope, instrument)`` for a supported HST/JWST imager, else ``None``.

    Trusts ``TELESCOP``+``INSTRUME`` but falls back to ``INSTRUME`` alone (the
    instrument names are telescope-unique) when ``TELESCOP`` is absent.
    """
    telescope = _get(header, "TELESCOP")
    instrume = _get(header, "INSTRUME")
    if telescope == "JWST" or instrume in _JWST_INSTRUMENTS:
        name = _JWST_INSTRUMENTS.get(instrume)
        return ("JWST", name) if name is not None else None
    if telescope == "HST" or instrume in _HST_INSTRUMENTS:
        name = _HST_INSTRUMENTS.get(instrume)
        return ("HST", name) if name is not None else None
    return None


def _jwst_filter(header: fits.Header) -> str | None:
    """The science filter for a JWST NIRCam/NIRISS header from FILTER+PUPIL.

    The bandpass is whichever wheel holds a real filter token. When BOTH do —
    the NIRCam medium/narrow case, where the pupil wheel carries the narrow filter
    (e.g. F323N) behind a wide blocker in the filter wheel (e.g. F322W2) — the
    PUPIL element is the intended bandpass, so it wins.
    """
    filt = _get(header, "FILTER")
    pupil = _get(header, "PUPIL")
    if _is_filter_token(pupil):
        return pupil
    if _is_filter_token(filt):
        return filt
    return None


def _miri_filter(header: fits.Header) -> str | None:
    filt = _get(header, "FILTER")
    return filt if _is_filter_token(filt) else None


def _hst_filter(header: fits.Header, instrument: str) -> str | None:
    """The science filter for an HST header.

    WFC3 carries a single ``FILTER``; ACS uses ``FILTER1``/``FILTER2`` where one
    element is a ``CLEAR*`` blocker and the other is the filter. Ambiguous ACS
    pairs (two non-clear filter tokens, e.g. a polarizer combo) return ``None``.
    """
    if instrument == "WFC3":
        filt = _get(header, "FILTER")
        return filt if _is_filter_token(filt) else None
    # ACS: pick the single non-clear filter token across FILTER1/FILTER2.
    candidates = [
        tok
        for tok in (_get(header, "FILTER1"), _get(header, "FILTER2"))
        if not _is_clearish(tok) and _is_filter_token(tok)
    ]
    return candidates[0] if len(candidates) == 1 else None


def _wfc3_subinstrument(header: fits.Header) -> str:
    """``"WFC3/IR"`` or ``"WFC3/UVIS"`` from DETECTOR (defaults to UVIS)."""
    return "WFC3/IR" if _get(header, "DETECTOR") == "IR" else "WFC3/UVIS"


def _parse_pivot(lookup_key: str, filt: str) -> float:
    """Ordering-only pivot estimate (microns) from the filter number.

    Unit conventions differ by instrument: JWST filter numbers are in units of
    0.01 µm (F444W → 4.44 µm); HST optical (ACS, WFC3/UVIS) are in nm (F606W →
    0.606 µm). WFC3/IR is the trap — its numbers are in units of *10 nm*, i.e. the
    same 0.01-µm scale as JWST (F160W → 1.60 µm, NOT 0.16 µm). Only used when a
    filter is missing from :data:`PIVOT_UM`; the table is the source of truth.
    """
    m = re.match(r"^F(\d{3,4})", filt)
    if m is None:
        return 0.0
    num = int(m.group(1))
    if lookup_key in ("ACS", "WFC3/UVIS"):
        return num / 1000.0  # nm -> µm
    return num * 0.01  # JWST and WFC3/IR: 0.01-µm units


def detect_band(header: fits.Header) -> DetectedBand | None:
    """Identify the science band from an HST/JWST imaging header.

    Returns ``None`` (so the caller falls back to filename naming) when the
    telescope/instrument is unrecognized or no science filter can be resolved.
    """
    ident = _identify(header)
    if ident is None:
        return None
    telescope, instrument = ident

    if telescope == "JWST":
        filt = _miri_filter(header) if instrument == "MIRI" else _jwst_filter(header)
        lookup_key = instrument.upper()
    else:  # HST
        filt = _hst_filter(header, instrument)
        lookup_key = _wfc3_subinstrument(header) if instrument == "WFC3" else instrument
    if filt is None:
        return None

    pivot = PIVOT_UM.get((lookup_key, filt))
    if pivot is None:
        pivot = _parse_pivot(lookup_key, filt)
    return DetectedBand(
        filter=filt,
        instrument=instrument,
        telescope=telescope,
        pivot_um=pivot,
        is_broadband=_is_broadband(filt),
    )


# --- Filename-based fallback (used only by detect_band_from_filename) ----------

#: Instrument tokens recognized inside a filename (lowercase) -> (telescope,
#: instrument). Their names are telescope-unique, mirroring _identify's fallback.
_FILENAME_INSTRUMENTS: dict[str, tuple[str, str]] = {
    "nircam": ("JWST", "NIRCam"),
    "niriss": ("JWST", "NIRISS"),
    "miri": ("JWST", "MIRI"),
    "acs": ("HST", "ACS"),
    "wfc3": ("HST", "WFC3"),
}

#: A standalone filter / instrument token in a filename — bounded by a
#: non-alphanumeric char or the string edge (so ``_f090w_`` and ``.f090w-clear``
#: both hit, but ``xf090w`` does not). The filter body mirrors :data:`_FILTER_RE`.
_FILENAME_FILTER_RE = re.compile(r"(?<![a-z0-9])(f\d{3,4}(?:w2|lp|[wmnx])?)(?![a-z0-9])", re.I)
_FILENAME_INSTR_RE = re.compile(
    r"(?<![a-z0-9])(" + "|".join(_FILENAME_INSTRUMENTS) + r")(?![a-z0-9])", re.I
)

#: (PIVOT_UM lookup key, telescope, instrument), in the preference order used to
#: adopt an instrument for a filename whose instrument token was absent: the first
#: table entry holding the filter wins (modern JWST first). Cosmetic only — shared
#: filters have near-identical pivots, and ordering is all the pivot is used for.
_PIVOT_KEY_META: tuple[tuple[str, str, str], ...] = (
    ("NIRCAM", "JWST", "NIRCam"),
    ("NIRISS", "JWST", "NIRISS"),
    ("MIRI", "JWST", "MIRI"),
    ("WFC3/IR", "HST", "WFC3"),
    ("ACS", "HST", "ACS"),
    ("WFC3/UVIS", "HST", "WFC3"),
)


def _resolve_filter_only(filt: str) -> tuple[str, str, float]:
    """``(telescope, instrument, pivot)`` for a filter whose instrument is unknown.

    Adopts the first :data:`_PIVOT_KEY_META` entry whose table holds the filter (its
    pivot is instrument-independent to the precision ordering needs); a filter in no
    table keeps the JWST 0.01-µm convention for ordering and a blank instrument.
    """
    for lookup_key, telescope, instrument in _PIVOT_KEY_META:
        pivot = PIVOT_UM.get((lookup_key, filt))
        if pivot is not None:
            return telescope, instrument, pivot
    return "", "", _parse_pivot("NIRCAM", filt)


def detect_band_from_filename(filename: str) -> DetectedBand | None:
    """Best-effort band identity from a *filename* — the fallback when the header
    carries no instrument/filter keywords.

    Heuristic and lower-confidence than :func:`detect_band`: scans ``filename`` for a
    single standalone filter token (e.g. ``f090w``) and, if present, one instrument
    token (e.g. ``nircam``). Returns ``None`` when no — or more than one distinct —
    filter token is found, so an ambiguous name (a PSF-matched ``f200w_to_f444w``
    product) safely falls back to plain filename naming.

    With an instrument token the pivot comes from the curated table (WFC3's
    sub-instrument is recovered by which sub-table holds the filter); without one,
    :func:`_resolve_filter_only` recovers it from the filter alone.
    """
    filts = {m.group(1).upper() for m in _FILENAME_FILTER_RE.finditer(filename)}
    if len(filts) != 1:
        return None
    filt = next(iter(filts))

    instrs = {m.group(1).lower() for m in _FILENAME_INSTR_RE.finditer(filename)}
    if len(instrs) == 1:
        telescope, instrument = _FILENAME_INSTRUMENTS[next(iter(instrs))]
        if instrument == "WFC3":
            lookup_key = next(
                (k for k in ("WFC3/IR", "WFC3/UVIS") if (k, filt) in PIVOT_UM), "WFC3/UVIS"
            )
        else:
            lookup_key = instrument.upper()
        pivot = PIVOT_UM.get((lookup_key, filt))
        if pivot is None:
            pivot = _parse_pivot(lookup_key, filt)
    else:
        telescope, instrument, pivot = _resolve_filter_only(filt)

    return DetectedBand(
        filter=filt,
        instrument=instrument,
        telescope=telescope,
        pivot_um=pivot,
        is_broadband=_is_broadband(filt),
    )
