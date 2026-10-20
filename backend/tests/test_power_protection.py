"""POWER_PROTECTED_OUTLETS parsing: an unusable list must never read as "nothing protected"."""
from types import SimpleNamespace as N

import pytest

from app.power_protection import parse

PDUS = [N(id="p1", name="pdu-rack01", port_count=24), N(id="p2", name="pdu-rack02", port_count=0),
        N(id="p3", name="twin", port_count=8), N(id="p4", name="twin", port_count=8)]


def test_empty_is_not_configured():
    for raw in ("", "   ", None):
        protection = parse(raw, PDUS)
        assert not protection.configured and not protection.usable


def test_none_is_an_explicit_empty_list():
    protection = parse(" None ", PDUS)
    assert protection.usable and protection.outlets == frozenset()


def test_ids_and_unique_names_resolve():
    protection = parse("pdu-rack01:3, p2:5", PDUS)
    assert protection.usable
    assert protection.outlets == {("p1", 3), ("p2", 5)}
    assert protection.is_protected("p1", 3) and not protection.is_protected("p1", 4)
    assert protection.for_pdu("p2") == {5}


@pytest.mark.parametrize("raw", [",,", "pdu-rack01:4,,", "pdu-rack01:30", "nosuch:1", "twin:1", "pdu-rack01",
                                 "pdu-rack01:x", ":3", "pdu-rack01:0", "none,pdu-rack01:3"])
def test_any_bad_entry_makes_the_list_unusable(raw):
    protection = parse(raw, PDUS)
    assert protection.configured and protection.errors and not protection.usable
