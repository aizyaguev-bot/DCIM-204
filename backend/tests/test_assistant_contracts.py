"""Shared redaction rules (contracts.redact_text / redact_tree): complete removal and linear time."""
import json
import time

import pytest

from app.assistant.contracts import redact_text, redact_tree


@pytest.mark.parametrize("text, secret", [
    ("opt11 password=hunter2", "hunter2"),
    ("db_password = 'two words'", "two words"),
    ('"api_key": "sk-live-123"', "sk-live-123"),
    ("token:" + "x" * 2000, "x" * 600),                       # long values are removed whole
    ("password" + " " * 40 + "=" + " " * 40 + "longsecret", "longsecret"),  # any spacing around the separator
    ("session_hash\t:\tabcdef0123", "abcdef0123"),
    ("label SECRET=s3cr3t, next", "s3cr3t"),
    ("see https://admin:pw@host/x", "admin"),
    ("see https://admin:pw@host/x", "pw@"),
    ("https://" + "u" * 1000 + ":" + "p" * 1000 + "@host", "p" * 100),  # long userinfo removed whole
    ("ssh://root:toor@10.0.0.1/x", "toor"),
    ("mail a.b@example.com now", "example.com"),
    ("Authorization: Bearer abc.def.ghi", "abc.def.ghi"),
    ("key sk-ant-ABCDEFGHIJKLMNOP", "ABCDEFGHIJKLMNOP"),
    ("password=\u00a0DEMOA", "DEMOA"),                          # Codex R2c: any Unicode space, line breaks too
    ("password =\nDEMOB", "DEMOB"),
    ("token\r\n:\tDEMOC", "DEMOC"),
    ("https://u:DEMOD?tail@host/path", "DEMOD"),                 # Codex R2c: '?' or '#' inside the password
    ("https://u:DEMOE#tail@host/path", "DEMOE"),
    ("x@" + ".".join("s%d" % i for i in range(10)) + ".example.com", "example.com"),  # many labels: whole address
    ("login root@server1 now", "root@"),                         # dotless addresses too
    ("login root@server1 now", "server1"),
], ids=lambda v: "%d" % len(v) if isinstance(v, str) else None)
def test_secret_is_removed(text, secret):
    assert secret not in redact_text(text)


@pytest.mark.parametrize("text", ["OPT11 Rack-01", "pdu-rack01 outlet 3", "https://host/path?q=1#frag", "ping @ 10:00", "username list",
                                  "שרת OPT11 בארון Rack-01", "token count 5"])
def test_ordinary_text_is_kept(text):
    assert redact_text(text) == text


def test_tree_redacts_keys_and_nested_values():
    data = {"opt11 password=k": [{"note": "https://u:p@h/", "x": ("token=tkmarker9", 3)}], "ok": "Rack-01"}
    dumped = json.dumps(redact_tree(data))
    for secret in ("=k", "u:p@", "tkmarker9"):
        assert secret not in dumped
    assert "Rack-01" in dumped


@pytest.mark.parametrize("text", [
    "a-" * 25_000,
    "a" * 50_000,
    "x." * 25_000 + "@",
    "password" * 6_000,
    "password " * 6_000,
    "https://" + "a" * 50_000,
    "https://" * 6_000,
    ("p=" * 25_000),
    "a@" * 25_000,
    "\"password\" " * 5_000,
    "password" * 6_000 + "=",                                     # Codex R2c: empty value must not rescan
    "password" * 6_000 + "= ",
    "password\n" * 6_000,
    "https://a?" * 6_000,
    "a." * 25_000 + "@",
    "@a" * 25_000,
], ids=lambda t: "len%d-%s" % (len(t), "".join(c for c in t[:12] if c.isalnum())))
def test_linear_time_on_hostile_input(text):
    started = time.perf_counter()
    redact_text(text)
    assert time.perf_counter() - started < 0.5
