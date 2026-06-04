"""Tests for the tiny .env reader (env_file.py).

The pure parser is exercised against the cases a credentials file actually hits;
the loader is tested for the load-bearing precedence rule (real env wins) and the
missing-file no-op.
"""

import os

import pytest

from fitsgl.env_file import load_env_file, parse_env_file


# ----------------------------------------------------------------- parser

def test_parses_basic_pairs():
    env = parse_env_file("R2_ACCESS_KEY_ID=abc\nR2_SECRET_ACCESS_KEY=def\n")
    assert env == {"R2_ACCESS_KEY_ID": "abc", "R2_SECRET_ACCESS_KEY": "def"}


def test_ignores_blanks_and_comments():
    text = "# a comment\n\n   \nKEY=value\n  # indented comment\n"
    assert parse_env_file(text) == {"KEY": "value"}


def test_strips_export_prefix():
    assert parse_env_file("export KEY=value\n") == {"KEY": "value"}
    # `export` with a tab, and a bare `exported` key that only *starts* with export.
    assert parse_env_file("export\tKEY=value\n") == {"KEY": "value"}
    assert parse_env_file("exported=1\n") == {"exported": "1"}  # not the prefix


def test_strips_whitespace_around_key_and_value():
    assert parse_env_file("  KEY   =   value  \n") == {"KEY": "value"}


def test_strips_surrounding_quotes():
    assert parse_env_file('A="quoted value"\nB=\'single\'\n') == {"A": "quoted value", "B": "single"}
    # Quotes preserve inner whitespace and any '#' inside them.
    assert parse_env_file('A=" sp ace "\nB="tok#en"\n') == {"A": " sp ace ", "B": "tok#en"}


def test_inline_comment_only_after_whitespace():
    assert parse_env_file("KEY=value  # trailing note\n") == {"KEY": "value"}
    assert parse_env_file("KEY=tok#frag\n") == {"KEY": "tok#frag"}  # no space → part of value
    assert parse_env_file("KEY=  # only a comment\n") == {"KEY": ""}


def test_skips_lines_without_equals_or_with_spaced_key():
    assert parse_env_file("not an assignment\nKEY=ok\nbad key=nope\n") == {"KEY": "ok"}


def test_later_assignment_wins():
    assert parse_env_file("K=1\nK=2\n") == {"K": "2"}


def test_empty_value():
    assert parse_env_file("K=\n") == {"K": ""}


# ----------------------------------------------------------------- loader

def test_load_missing_file_is_noop(tmp_path):
    assert load_env_file(tmp_path / "nope.env") == []


def test_load_sets_only_absent_keys(tmp_path, monkeypatch):
    monkeypatch.delenv("FITSGL_TEST_A", raising=False)
    monkeypatch.setenv("FITSGL_TEST_B", "from-shell")
    p = tmp_path / ".env"
    p.write_text("FITSGL_TEST_A=from-file\nFITSGL_TEST_B=from-file\n")

    applied = load_env_file(p)
    assert applied == ["FITSGL_TEST_A"]  # B already set in the env → not applied
    assert os.environ["FITSGL_TEST_A"] == "from-file"
    assert os.environ["FITSGL_TEST_B"] == "from-shell"  # real env wins


def test_load_override_replaces_existing(tmp_path, monkeypatch):
    monkeypatch.setenv("FITSGL_TEST_C", "from-shell")
    p = tmp_path / ".env"
    p.write_text("FITSGL_TEST_C=from-file\n")
    assert load_env_file(p, override=True) == ["FITSGL_TEST_C"]
    assert os.environ["FITSGL_TEST_C"] == "from-file"


def test_load_directory_path_is_noop(tmp_path):
    # A path that exists but isn't a regular file (here, a directory named .env) is
    # treated as absent rather than crashing.
    (tmp_path / ".env").mkdir()
    assert load_env_file(tmp_path / ".env") == []


@pytest.mark.skipif(hasattr(os, "geteuid") and os.geteuid() == 0, reason="root bypasses file permissions")
def test_load_unreadable_file_raises(tmp_path):
    # An existing-but-unreadable file surfaces OSError (the caller turns it into a
    # pointed CLI error), rather than being silently skipped.
    bad = tmp_path / "unreadable.env"
    bad.write_text("K=v\n")
    bad.chmod(0o000)
    try:
        with pytest.raises(OSError):
            load_env_file(bad)
    finally:
        bad.chmod(0o600)  # restore so tmp cleanup can remove it
