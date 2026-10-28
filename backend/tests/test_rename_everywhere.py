"""POST /api/devices/rename-opt: renaming a server everywhere at once, with a preview (dry_run) and a plan_revision.

The server's PDU outlets (each feed keeps its suffix), KVM port, rack layout ids, ping monitor and owner follow the new
name. A name that is already another server, or a default port name, is refused. Every PDU and KVM is a simulated
database row; nothing contacts a device. Layout files and the legacy owners file live in tmp_path."""
import json
from types import SimpleNamespace

import pytest
from sqlalchemy import select

import app.main as main
from app import inventory_store, name_sync
from app.engineers import owner_map
from app.models import AssetOwner, Device, PingTarget
from app.routers import devices

LAYOUT = {
    "rack_slots.json": {"Rack-01": {"optn44": 3, "optn45 (psu1)": 7}, "Rack-02": {"optn44 (psu2)": 3}},
    "rack_positions.json": {"Rack-01": ["optn45 (psu1)", "optn44", "web-1"]},
    "rack_overrides.json": {"optn45 (psu1)": "Rack-01", "other": "Rack-09"},
    "switch_assignments.json": {"optn44": {"switch": "SW1", "port": "12"}, "optn45 (psu1)": {"switch": "SW2", "port": "3"}},
}
LABELS = {
    "pdu-a": {"1": "OPTN44", "2": "OPTN45 (PSU1)", "3": "web-1"},
    "pdu-b": {"1": "optn44 (PSU2)", "2": "OPTN45 (PSU2)", "5": "Outlet 5"},
    "kvm-a": {"1": "optn44", "2": "OPTN45"},
}
EXISTS = "{} already exists — use Locations to swap or move"


def lab_devices():
    return [
        Device(id="pdu-a", name="PDU-A", kind="pdu", ip="192.0.2.11", rack="Rack-01", port_count=8,
               labels_json=json.dumps(LABELS["pdu-a"])),
        Device(id="pdu-b", name="PDU-B", kind="pdu", ip="192.0.2.12", rack="Rack-02", port_count=8,
               labels_json=json.dumps(LABELS["pdu-b"])),
        Device(id="kvm-a", name="KVM-A", kind="kvm", ip="192.0.2.13", rack="Rack-01", port_count=4,
               labels_json=json.dumps(LABELS["kvm-a"])),
    ]


def write_layout(folder, layout=LAYOUT):
    for name, data in layout.items():
        (folder / name).write_text(json.dumps(data))


def read_layout(folder):
    return {name: json.loads((folder / name).read_text()) for name in LAYOUT if (folder / name).exists()}


def snapshot(folder):
    return {p.name: p.read_bytes() for p in sorted(folder.iterdir()) if p.is_file() and p.suffix != ".lock"}


async def saved_labels(db):
    rows = (await db.execute(select(Device).execution_options(populate_existing=True))).scalars().all()
    return {d.id: json.loads(d.labels_json) for d in rows}


async def people(db):
    targets = (await db.execute(select(PingTarget).execution_options(populate_existing=True))).scalars().all()
    owners = (await db.execute(select(AssetOwner).execution_options(populate_existing=True))).scalars().all()
    return (sorted((t.id, t.source_key, t.name, t.host, t.revision) for t in targets),
            sorted((o.asset_key, o.engineer_id or "", o.legacy_name) for o in owners))


@pytest.fixture
async def lab(client, db_session, tmp_path, monkeypatch):
    monkeypatch.setattr(devices, "_BACKEND_DIR", tmp_path)
    monkeypatch.setattr(inventory_store, "ITEMS_FILE", tmp_path / "rack_items.json")
    monkeypatch.setattr(main, "_OPT_OWNERS_FILE", tmp_path / "opt_owners.json")
    queued = []

    async def queue(device_ports):
        queued.append({k: set(v) for k, v in device_ports.items()})
        return {"device_names": "queued"}

    monkeypatch.setattr(name_sync, "queue", queue)
    db_session.add_all(lab_devices())
    db_session.add(PingTarget(id="t45", source_key="server:optn45", name="OPTN45", host="optn45"))
    db_session.add(AssetOwner(asset_key="optn45", legacy_name="Roy"))
    await db_session.commit()
    write_layout(tmp_path)
    return SimpleNamespace(client=client, db=db_session, folder=tmp_path, queued=queued)


async def rename(lab, old_name, new_name, **extra):
    return await lab.client.post("/api/devices/rename-opt", json={"old_name": old_name, "new_name": new_name, **extra})


async def unchanged(lab, files, before):
    assert await saved_labels(lab.db) == LABELS
    assert snapshot(lab.folder) == files
    assert await people(lab.db) == before
    assert lab.queued == []


PREVIEW_CHANGES = [
    {"device_id": "pdu-a", "device_name": "PDU-A", "kind": "pdu", "port": "2", "before": "OPTN45 (PSU1)", "after": "OPTN46 (PSU1)"},
    {"device_id": "pdu-b", "device_name": "PDU-B", "kind": "pdu", "port": "2", "before": "OPTN45 (PSU2)", "after": "OPTN46 (PSU2)"},
    {"device_id": "kvm-a", "device_name": "KVM-A", "kind": "kvm", "port": "2", "before": "OPTN45", "after": "OPTN46"},
]


async def test_dry_run_lists_every_port_layout_id_monitor_and_owner_and_writes_nothing(lab):
    files, before = snapshot(lab.folder), await people(lab.db)
    r = await rename(lab, "OPTN45 (PSU1)", "OPTN46 (PSU1)", dry_run=True)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True and body["dry_run"] is True
    assert (body["old_name"], body["new_name"]) == ("OPTN45 (PSU1)", "OPTN46 (PSU1)")
    assert body["changes"] == PREVIEW_CHANGES
    assert body["layout"] == [
        {"file": "rack_overrides.json", "rack": "Rack-01", "before": "optn45 (psu1)", "after": "optn46 (psu1)"},
        {"file": "rack_positions.json", "rack": "Rack-01", "before": "optn45 (psu1)", "after": "optn46 (psu1)"},
        {"file": "rack_slots.json", "rack": "Rack-01", "before": "optn45 (psu1)", "after": "optn46 (psu1)", "slot": 7},
        {"file": "switch_assignments.json", "rack": None, "before": "optn45 (psu1)", "after": "optn46 (psu1)"},
    ]
    assert body["position"] == {"rack": "Rack-01", "slot": 7}
    assert body["monitor"] == {"before": "OPTN45", "after": "OPTN46", "host": "optn45"}
    assert body["owner"] == {"name": "Roy", "before": "OPTN45", "after": "OPTN46"}
    assert isinstance(body["plan_revision"], str) and body["plan_revision"]
    assert "device_names" not in body
    await unchanged(lab, files, before)
    # The same state previews the same plan.
    again = await rename(lab, "OPTN45 (PSU1)", "OPTN46 (PSU1)", dry_run=True)
    assert again.json()["plan_revision"] == body["plan_revision"]


async def test_apply_with_the_preview_token_does_exactly_what_was_previewed(lab):
    preview = (await rename(lab, "OPTN45 (PSU1)", "OPTN46 (PSU1)", dry_run=True)).json()
    r = await rename(lab, "OPTN45 (PSU1)", "OPTN46 (PSU1)", plan_revision=preview["plan_revision"])
    assert r.status_code == 200, r.text
    labels = await saved_labels(lab.db)
    assert labels == {
        "pdu-a": {**LABELS["pdu-a"], "2": "OPTN46 (PSU1)"},
        "pdu-b": {**LABELS["pdu-b"], "2": "OPTN46 (PSU2)"},
        "kvm-a": {**LABELS["kvm-a"], "2": "OPTN46"},
    }
    body = r.json()
    assert body["updated_devices"] == ["PDU-A", "PDU-B", "KVM-A"] and body["device_names"] == "queued"
    assert body["labels_revisions"] == {k: inventory_store.revision(v) for k, v in labels.items()}
    # Device name sync gets exactly the renamed ports (it never writes a KVM itself; see test_name_sync).
    assert lab.queued == [{"pdu-a": {"2"}, "pdu-b": {"2"}, "kvm-a": {"2"}}]
    assert read_layout(lab.folder) == {
        "rack_slots.json": {"Rack-01": {"optn44": 3, "optn46 (psu1)": 7}, "Rack-02": {"optn44 (psu2)": 3}},
        "rack_positions.json": {"Rack-01": ["optn46 (psu1)", "optn44", "web-1"]},
        "rack_overrides.json": {"optn46 (psu1)": "Rack-01", "other": "Rack-09"},
        "switch_assignments.json": {"optn44": {"switch": "SW1", "port": "12"},
                                    "optn46 (psu1)": {"switch": "SW2", "port": "3"}},
    }
    targets, owners = await people(lab.db)
    assert targets == [("t45", "server:optn46", "OPTN46", "optn45", 1)]
    assert await owner_map(lab.db) == {"optn46": "Roy"}
    rows = {s["key"]: s for s in (await lab.client.get("/api/devices/locations")).json()["servers"]}
    assert "optn45" not in rows
    assert (rows["optn46"]["rack"], rows["optn46"]["slot"]) == ("Rack-01", 7)
    assert [(p["device_id"], p["port"]) for p in rows["optn46"]["pdu"] + rows["optn46"]["kvm"]] == [
        ("pdu-a", "2"), ("pdu-b", "2"), ("kvm-a", "2")]


async def test_apply_is_refused_when_anything_changed_since_the_preview(lab):
    preview = (await rename(lab, "OPTN45 (PSU1)", "OPTN46 (PSU1)", dry_run=True)).json()
    r = await lab.client.patch("/api/devices/direct-label", json={"device_id": "pdu-b", "port": "2", "label": "OPTN45 (B)"})
    assert r.status_code == 200, r.text
    lab.queued.clear()
    labels, files, before = await saved_labels(lab.db), snapshot(lab.folder), await people(lab.db)
    r = await rename(lab, "OPTN45 (PSU1)", "OPTN46 (PSU1)", plan_revision=preview["plan_revision"])
    assert r.status_code == 409 and r.json()["detail"] == "Changed since the preview. Preview again."
    assert await saved_labels(lab.db) == labels and snapshot(lab.folder) == files
    assert await people(lab.db) == before and lab.queued == []


async def test_a_layout_change_since_the_preview_is_refused_too(lab):
    preview = (await rename(lab, "OPTN45", "OPTN46", dry_run=True)).json()
    layout = json.loads(json.dumps(LAYOUT))
    layout["rack_slots.json"]["Rack-01"]["optn45 (psu1)"] = 9
    write_layout(lab.folder, layout)
    files, before = snapshot(lab.folder), await people(lab.db)
    r = await rename(lab, "OPTN45", "OPTN46", plan_revision=preview["plan_revision"])
    assert r.status_code == 409
    await unchanged(lab, files, before)


@pytest.mark.parametrize("new_name,existing", [
    ("optn44 (PSU1)", "OPTN44"),   # on PDU and KVM ports
    ("OPTN44", "OPTN44"),
    ("web-1", "web-1"),
    ("optn60", "optn60"),          # only in the rack layout files (a server without ports)
    ("OPTN61", "OPTN61"),          # only a ping monitor
])
@pytest.mark.parametrize("dry_run", [True, False])
async def test_a_name_that_is_already_another_server_is_refused(lab, new_name, existing, dry_run):
    layout = json.loads(json.dumps(LAYOUT))
    layout["rack_slots.json"]["Rack-02"]["optn60"] = 9
    write_layout(lab.folder, layout)
    lab.db.add(PingTarget(id="t61", source_key="server:optn61", name="OPTN61", host="optn61"))
    await lab.db.commit()
    files, before = snapshot(lab.folder), await people(lab.db)
    r = await rename(lab, "OPTN45 (PSU1)", new_name, dry_run=dry_run)
    assert r.status_code == 409 and r.json()["detail"] == EXISTS.format(existing)
    await unchanged(lab, files, before)


@pytest.mark.parametrize("old_name,new_name,bad", [
    ("Outlet 5", "optn50", "Outlet 5"),
    ("port 2", "optn50", "port 2"),
    ("OPTN45", "Outlet 9", "Outlet 9"),
    ("OPTN45", "Empty", "Empty"),
    ("OPTN45", "--", "--"),
])
@pytest.mark.parametrize("dry_run", [True, False])
async def test_default_port_names_are_refused(lab, old_name, new_name, bad, dry_run):
    files, before = snapshot(lab.folder), await people(lab.db)
    r = await rename(lab, old_name, new_name, dry_run=dry_run)
    assert r.status_code == 400
    assert r.json()["detail"] == f'"{bad}" is not a server name (a default port name or placeholder). ' \
                                 "Change that port on its own page."
    await unchanged(lab, files, before)


@pytest.mark.parametrize("extra,detail", [
    ({"dry_run": "yes"}, "dry_run must be true or false"),
    ({"plan_revision": 7}, "plan_revision must be the token from the preview"),
    ({"new_name": "x" * 201}, "Server names are at most 200 characters."),
])
async def test_bad_requests_change_nothing(lab, extra, detail):
    files, before = snapshot(lab.folder), await people(lab.db)
    body = {"old_name": "OPTN45", "new_name": "OPTN46", **extra}
    r = await lab.client.post("/api/devices/rename-opt", json=body)
    assert r.status_code == 400 and r.json()["detail"] == detail
    await unchanged(lab, files, before)


async def test_a_new_feed_suffix_on_the_same_server_changes_only_that_label(lab):
    files, before = snapshot(lab.folder), await people(lab.db)
    preview = (await rename(lab, "OPTN45 (PSU1)", "OPTN45 (A)", dry_run=True)).json()
    assert [(c["device_id"], c["after"]) for c in preview["changes"]] == [("pdu-a", "OPTN45 (A)")]
    assert (preview["monitor"], preview["owner"]) == (None, None)
    r = await rename(lab, "OPTN45 (PSU1)", "OPTN45 (A)", plan_revision=preview["plan_revision"])
    assert r.status_code == 200, r.text
    assert (await saved_labels(lab.db))["pdu-b"]["2"] == "OPTN45 (PSU2)"
    assert await people(lab.db) == before


async def test_automatic_rack_units_are_pinned_when_a_new_name_would_reorder_the_rack(lab):
    # The DCIM view numbers servers without a saved U by name: alpha U1, beta U2. Renamed to zeta, alpha would
    # become U2 and push beta to U1, so both keep the U they show now.
    lab.db.add(Device(id="pdu-c", name="PDU-C", kind="pdu", ip="192.0.2.15", rack="Rack-05", port_count=4,
                      labels_json=json.dumps({"1": "alpha", "2": "beta"})))
    await lab.db.commit()
    rows = {s["key"]: s for s in (await lab.client.get("/api/devices/locations")).json()["servers"]}
    preview = (await rename(lab, "alpha", "zeta", dry_run=True)).json()
    assert preview["position"] == {"rack": "Rack-05", "slot": 1}
    assert [e for e in preview["layout"] if e["rack"] == "Rack-05"] == [
        {"file": "rack_slots.json", "rack": "Rack-05", "before": None, "after": "beta", "slot": 2},
        {"file": "rack_slots.json", "rack": "Rack-05", "before": None, "after": "zeta", "slot": 1},
    ]
    r = await rename(lab, "alpha", "zeta", plan_revision=preview["plan_revision"])
    assert r.status_code == 200, r.text
    assert read_layout(lab.folder)["rack_slots.json"]["Rack-05"] == {"beta": 2, "zeta": 1}
    after = {s["key"]: s for s in (await lab.client.get("/api/devices/locations")).json()["servers"]}
    assert (after["zeta"]["rack"], after["zeta"]["slot"]) == ("Rack-05", 1)
    assert (after["beta"]["rack"], after["beta"]["slot"]) == ("Rack-05", 2)
    assert rows["beta"]["rack"] == "Rack-05"


async def test_a_rename_that_keeps_the_rack_order_pins_nothing(lab):
    lab.db.add(Device(id="pdu-c", name="PDU-C", kind="pdu", ip="192.0.2.15", rack="Rack-05", port_count=4,
                      labels_json=json.dumps({"1": "alpha", "2": "beta"})))
    await lab.db.commit()
    preview = (await rename(lab, "alpha", "aardvark", dry_run=True)).json()
    assert [e for e in preview["layout"] if e["rack"] == "Rack-05"] == []
    r = await rename(lab, "alpha", "aardvark", plan_revision=preview["plan_revision"])
    assert r.status_code == 200, r.text
    assert "Rack-05" not in read_layout(lab.folder)["rack_slots.json"]


async def test_apply_without_a_token_still_works_for_the_racks_page(lab):
    r = await rename(lab, "OPTN45", "OPTN47")
    assert r.status_code == 200, r.text
    labels = await saved_labels(lab.db)
    assert (labels["pdu-a"]["2"], labels["pdu-b"]["2"], labels["kvm-a"]["2"]) == ("OPTN47 (PSU1)", "OPTN47 (PSU2)", "OPTN47")
