"""Tests for HST/JWST filter detection (bands.py)."""

import pytest
from astropy.io import fits

from fitsgl.bands import detect_band, detect_band_from_filename


def _hdr(**cards) -> fits.Header:
    h = fits.Header()
    for k, v in cards.items():
        h[k] = v
    return h


# (header cards, filter, instrument, telescope, is_broadband)
_CASES = [
    # JWST NIRCam wide imaging: filter wheel holds the band, pupil is CLEAR.
    (dict(TELESCOP="JWST", INSTRUME="NIRCAM", FILTER="F444W", PUPIL="CLEAR"), "F444W", "NIRCam", "JWST", True),
    (dict(TELESCOP="JWST", INSTRUME="NIRCAM", FILTER="F150W", PUPIL="CLEAR"), "F150W", "NIRCam", "JWST", True),
    # NIRCam pupil filter: wide blocker in FILTER, narrow/medium in PUPIL -> PUPIL wins.
    (dict(TELESCOP="JWST", INSTRUME="NIRCAM", FILTER="F322W2", PUPIL="F323N"), "F323N", "NIRCam", "JWST", False),
    (dict(TELESCOP="JWST", INSTRUME="NIRCAM", FILTER="F444W", PUPIL="F470N"), "F470N", "NIRCam", "JWST", False),
    # NIRCam wide blocker used alone (PUPIL=CLEAR) is itself a broadband.
    (dict(TELESCOP="JWST", INSTRUME="NIRCAM", FILTER="F150W2", PUPIL="CLEAR"), "F150W2", "NIRCam", "JWST", True),
    # NIRISS (CLEARP is the pupil blocker; some filters live in the pupil wheel).
    (dict(TELESCOP="JWST", INSTRUME="NIRISS", FILTER="F150W", PUPIL="CLEARP"), "F150W", "NIRISS", "JWST", True),
    (dict(TELESCOP="JWST", INSTRUME="NIRISS", FILTER="CLEAR", PUPIL="F200W"), "F200W", "NIRISS", "JWST", True),
    # JWST MIRI imaging (FILTER only).
    (dict(TELESCOP="JWST", INSTRUME="MIRI", FILTER="F1500W"), "F1500W", "MIRI", "JWST", True),
    # HST ACS/WFC: one of FILTER1/FILTER2 is CLEAR*, the other is the science filter.
    (dict(TELESCOP="HST", INSTRUME="ACS", FILTER1="CLEAR1L", FILTER2="F606W"), "F606W", "ACS", "HST", True),
    (dict(TELESCOP="HST", INSTRUME="ACS", FILTER1="F814W", FILTER2="CLEAR2L"), "F814W", "ACS", "HST", True),
    (dict(TELESCOP="HST", INSTRUME="ACS", FILTER1="CLEAR1L", FILTER2="F850LP"), "F850LP", "ACS", "HST", False),
    # HST WFC3/UVIS & WFC3/IR (single FILTER; DETECTOR disambiguates the sub-instrument).
    (dict(TELESCOP="HST", INSTRUME="WFC3", DETECTOR="UVIS", FILTER="F606W"), "F606W", "WFC3", "HST", True),
    (dict(TELESCOP="HST", INSTRUME="WFC3", DETECTOR="IR", FILTER="F160W"), "F160W", "WFC3", "HST", True),
    # TELESCOP missing: the instrument name is telescope-unique, so it still resolves.
    (dict(INSTRUME="NIRCAM", FILTER="F277W", PUPIL="CLEAR"), "F277W", "NIRCam", "JWST", True),
]


@pytest.mark.parametrize("cards,filt,instr,tel,broad", _CASES)
def test_detect_band(cards, filt, instr, tel, broad):
    det = detect_band(_hdr(**cards))
    assert det is not None
    assert (det.filter, det.instrument, det.telescope, det.is_broadband) == (filt, instr, tel, broad)
    assert det.pivot_um > 0.0


def test_detect_band_is_case_insensitive():
    det = detect_band(_hdr(TELESCOP="jwst", INSTRUME="nircam", FILTER="f444w", PUPIL="clear"))
    assert det is not None and det.filter == "F444W" and det.instrument == "NIRCam"


def test_pivot_from_table_orders_blue_to_red():
    blue = detect_band(_hdr(TELESCOP="JWST", INSTRUME="NIRCAM", FILTER="F150W", PUPIL="CLEAR"))
    red = detect_band(_hdr(TELESCOP="JWST", INSTRUME="NIRCAM", FILTER="F444W", PUPIL="CLEAR"))
    assert blue is not None and red is not None
    assert blue.pivot_um < red.pivot_um
    assert blue.pivot_um == pytest.approx(1.501, abs=0.01)
    assert red.pivot_um == pytest.approx(4.421, abs=0.01)


def test_wfc3_ir_fallback_uses_10nm_units():
    # F128N is a real WFC3/IR narrowband not in the curated table -> fallback parse.
    # The trap: WFC3/IR numbers are 10-nm units, so this must be ~1.28 µm, not 0.128.
    det = detect_band(_hdr(TELESCOP="HST", INSTRUME="WFC3", DETECTOR="IR", FILTER="F128N"))
    assert det is not None and not det.is_broadband
    assert det.pivot_um == pytest.approx(1.28, abs=0.02)


def test_acs_fallback_uses_nm_units():
    # F892N is an ACS narrowband not in the curated table -> nm units -> ~0.892 µm.
    det = detect_band(_hdr(TELESCOP="HST", INSTRUME="ACS", FILTER1="CLEAR1L", FILTER2="F892N"))
    assert det is not None
    assert det.pivot_um == pytest.approx(0.892, abs=0.01)


# --- filename fallback (detect_band_from_filename) -----------------------------

# (filename, filter, instrument, telescope, is_broadband)
_FILENAME_CASES = [
    # The motivating case: a community NIRCam mosaic with instrument + filter in name.
    ("mosaic_nircam_f090w_uds_30mas_v1_0_1_primer_sci.fits", "F090W", "NIRCam", "JWST", True),
    ("mosaic_nircam_f444w_uds_30mas_v1_0_1_primer_sci.fits", "F444W", "NIRCam", "JWST", True),
    ("mosaic_nircam_f410m_uds_30mas_v1_0_1_primer_sci.fits", "F410M", "NIRCam", "JWST", False),
    # Bare filter, no instrument token -> recovered from the curated table (NIRCam).
    ("f090w.fits", "F090W", "NIRCam", "JWST", True),
    ("f150w2.fits", "F150W2", "NIRCam", "JWST", True),  # wide blocker
    # A trailing pupil/blocker after the token (Grizli-style) is ignored.
    ("jw_f356w-clear_i2d.fits", "F356W", "NIRCam", "JWST", True),
    # HST instrument tokens.
    ("acs_f814w_drz.fits", "F814W", "ACS", "HST", True),
    # WFC3 sub-instrument recovered from whichever sub-table holds the filter.
    ("wfc3_f160w_sci.fits", "F160W", "WFC3", "HST", True),  # F160W is WFC3/IR
    ("wfc3_f606w_sci.fits", "F606W", "WFC3", "HST", True),  # F606W is WFC3/UVIS
]


@pytest.mark.parametrize("name,filt,instr,tel,broad", _FILENAME_CASES)
def test_detect_band_from_filename(name, filt, instr, tel, broad):
    det = detect_band_from_filename(name)
    assert det is not None
    assert (det.filter, det.instrument, det.telescope, det.is_broadband) == (filt, instr, tel, broad)
    assert det.pivot_um > 0.0


def test_filename_fallback_orders_blue_to_red():
    blue = detect_band_from_filename("f090w.fits")
    red = detect_band_from_filename("f444w.fits")
    assert blue is not None and red is not None and blue.pivot_um < red.pivot_um


def test_filename_fallback_unknown_instrument_and_filter_still_orders():
    # A filter in no curated table: instrument stays blank, but a JWST-convention
    # pivot is still produced so the band can be ordered.
    det = detect_band_from_filename("mosaic_f128n_sci.fits")  # F128N is in no table
    assert det is not None and det.instrument == "" and det.telescope == ""
    assert det.pivot_um == pytest.approx(1.28, abs=0.02)  # JWST 0.01-µm convention


@pytest.mark.parametrize(
    "name",
    [
        "weight.fits",  # no filter token at all
        "drizzle_30mas_v1_0_1.fits",  # version/scale numbers, no F-token
        "xf090w.fits",  # not standalone (no boundary before the token)
        "f200w_matched_to_f444w.fits",  # ambiguous: two distinct filter tokens
    ],
)
def test_detect_band_from_filename_returns_none(name):
    assert detect_band_from_filename(name) is None


@pytest.mark.parametrize(
    "cards",
    [
        dict(),  # nothing
        dict(FILTER="F444W"),  # no telescope/instrument
        dict(TELESCOP="JWST", INSTRUME="NIRSPEC", FILTER="F100LP"),  # unsupported JWST instrument
        dict(TELESCOP="JWST", INSTRUME="FGS"),  # unsupported JWST instrument
        dict(TELESCOP="HST", INSTRUME="ACS", FILTER1="CLEAR1L", FILTER2="CLEAR2L"),  # both clear
        dict(TELESCOP="HST", INSTRUME="ACS", FILTER1="F606W", FILTER2="F814W"),  # ambiguous dual filter
        dict(TELESCOP="JWST", INSTRUME="NIRCAM", FILTER="CLEAR", PUPIL="CLEAR"),  # no filter token
        dict(TELESCOP="JWST", INSTRUME="MIRI", FILTER="P750L"),  # non-imaging (LRS prism) token
    ],
)
def test_detect_band_returns_none(cards):
    assert detect_band(_hdr(**cards)) is None
