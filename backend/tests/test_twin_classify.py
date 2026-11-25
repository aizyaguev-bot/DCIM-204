"""The 3D link rule (v2 spec section M.5), Python copy: app/lab_trash.py classify_twin. The same hand-written fixture
(tests/fixtures/twin_classify.json) pins frontend/src/lab/twinRecords.js and lab-twin/classify.js, so the three copies
link the same lab-data.json records to the same Lab Manager records and give the same reasons for the others."""
import json
import pathlib

import pytest

from app.lab_trash import classify_twin, js_identity, norm_name

ROOT = pathlib.Path(__file__).resolve().parents[2]
FIXTURE = json.loads((pathlib.Path(__file__).parent / "fixtures" / "twin_classify.json").read_text(encoding="utf-8"))


def by_id(only):
    return {o["id"]: o["reason"] for o in only}


def test_the_fixture_has_a_case_for_every_rule():
    names = "\n".join(c["name"] for c in FIXTURE["cases"])
    for rule in ("device id", "unique normalized name", "same name", "optKey", "equipment", "hidden", "chiller",
                 "other item types", "setups", "storage"):
        assert rule in names


@pytest.mark.parametrize("case", FIXTURE["cases"], ids=[c["name"][:60] for c in FIXTURE["cases"]])
def test_classify_twin_matches_the_fixture(case):
    got = classify_twin(case["twin"], case["live"])
    assert got["linked"] == case["expected"]["linked"]
    assert by_id(got["only"]) == by_id(case["expected"]["only"])
    assert len(got["only"]) == len(case["expected"]["only"]), "each record is listed once"


def test_types_names_and_empty_input():
    got = classify_twin({"items": [{"id": "I1", "type": "cart", "name": "Cart"}], "storage": [{"id": "S1", "name": "Cabinet"}],
                         "setups": [{"id": "U1"}]}, {})
    assert [(o["id"], o["type"]) for o in got["only"]] == [("I1", "cart"), ("S1", "storage"), ("U1", "setup")]
    assert classify_twin(None, None) == {"linked": {}, "only": []}
    assert norm_name("  PDU   Rack 08 ") == "pdu rack 08"
    assert js_identity("Optn85 (SSD)") == "optn85" and js_identity("Outlet 3") is None and js_identity("") is None


def test_the_unchanged_lab_data_json_is_the_ids_mismatch_case():
    """The browser fixture keeps lab-twin/lab-data.json as it is: only PDU-Rack-08 links (by its unique name)."""
    twin = json.loads((ROOT / "lab-twin" / "lab-data.json").read_text(encoding="utf-8"))
    devices = [*({"id": f"pdu{i}", "kind": "pdu", "name": f"PDU 0{i}"} for i in range(1, 8)),
               {"id": "pdu8", "kind": "pdu", "name": "PDU-Rack-08"}, {"id": "kvm1", "kind": "kvm", "name": "KVM 01"},
               {"id": "kvm2", "kind": "kvm", "name": "KVM 02"}]
    got = classify_twin(twin, {"devices": devices, "racks": [f"Rack-0{i}" for i in range(1, 8)]})
    assert got["linked"]["ITEM-0040"] == "dev:pdu8"
    reasons = by_id(got["only"])
    assert reasons["ITEM-0033"] == "No PDU with id pdu-rack01 or name PDU-Rack-01 in Lab Manager"
    assert reasons["ITEM-0041"] == "No KVM with id kvm-unit1 or name KVM-Unit-1 in Lab Manager"
    assert reasons["ITEM-0044"] == "3D only"
    assert got["linked"]["SETUP-007"] == "rack:Rack-07"
