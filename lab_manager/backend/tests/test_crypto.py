"""Unit tests for app/crypto.py — Fernet encryption utilities."""
import warnings

from app.crypto import decrypt, encrypt


def test_roundtrip_basic():
    assert decrypt(encrypt("hello")) == "hello"


def test_roundtrip_empty_string():
    assert decrypt(encrypt("")) == ""


def test_roundtrip_unicode():
    s = "pässwørd—2025!@#"
    assert decrypt(encrypt(s)) == s


def test_roundtrip_long_string():
    s = "x" * 1000
    assert decrypt(encrypt(s)) == s


def test_fernet_randomised_iv():
    # Same plaintext must produce different ciphertext each time (random IV).
    c1 = encrypt("secret")
    c2 = encrypt("secret")
    assert c1 != c2


def test_dev_key_warning_when_master_key_unset(monkeypatch):
    from app.config import get_settings

    get_settings.cache_clear()
    monkeypatch.setenv("LAB_MANAGER_MASTER_KEY", "")
    try:
        with warnings.catch_warnings(record=True) as w:
            warnings.simplefilter("always")
            encrypt("test")
        assert any("insecure dev key" in str(x.message).lower() for x in w)
    finally:
        get_settings.cache_clear()
