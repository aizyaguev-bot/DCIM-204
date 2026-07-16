"""
Seed your real lab devices into the database.
Run once after first install:  python seed.py
Re-run any time to update labels or add devices (safe to run repeatedly).

Reads PDU_USERNAME / PDU_PASSWORD / KVM_USERNAME / KVM_PASSWORD from .env
"""
import asyncio, sys, os, json
sys.path.insert(0, os.path.dirname(__file__))

from app.database import init_db, AsyncSessionLocal
from app.models import Device
from app.crypto import encrypt
from app.config import get_settings

DEVICES = [
    # ---- PDUs ----
    dict(
        id="pdu-rack01", kind="pdu", name="PDU-Rack-01", model="Raritan PDU",
        ip="10.7.30.137", rack="Rack-01",
        labels={13: "Opt133", 21: "Opt183", 23: "Opt207", 24: "Optn85 (SSD)"},
    ),
    dict(
        id="pdu-rack02", kind="pdu", name="PDU-Rack-02", model="Raritan PDU",
        ip="10.7.30.136", rack="Rack-02",
        labels={6: "Optn130", 13: "Opt208", 20: "Optn84", 22: "Optn84 (2)"},
    ),
    dict(
        id="pdu-rack03", kind="pdu", name="PDU-Rack-03", model="Raritan PDU",
        ip="10.7.30.129", rack="Rack-03",
        labels={9: "Opt106", 17: "Optn36", 20: "Optn88", 23: "Optn51"},
    ),
    dict(
        id="pdu-rack04", kind="pdu", name="PDU-Rack-04", model="Raritan PDU",
        ip="10.7.30.93", rack="Rack-04",
        labels={9: "Opt60", 18: "Opt94", 19: "Optn144", 23: "Opt (unlabeled)"},
    ),
    dict(
        id="pdu-rack05", kind="pdu", name="PDU-Rack-05", model="Raritan PDU",
        ip="10.7.30.141", rack="Rack-05",
        labels={13: "Optn45", 22: "Opt (unlabeled)", 23: "Optn108"},
    ),
    dict(
        id="pdu-rack06", kind="pdu", name="PDU-Rack-06", model="Raritan PDU",
        ip="10.7.30.201", rack="Rack-06",
        labels={13: "Optn93", 17: "Opt250", 20: "Optn114", 22: "Optn101", 23: "Opt41"},
    ),
    dict(
        id="pdu-rack07", kind="pdu", name="PDU-Rack-07", model="Raritan PDU",
        ip="10.7.30.202", rack="Rack-07",          # ← update IP when known
        labels={9: "Optn29", 14: "Optn149"},
    ),
    # ---- KVMs ----
    dict(
        id="kvm-unit1", kind="kvm", name="KVM-Unit-1",
        model="Raritan Dominion KX III", ip="10.7.30.49", rack="Rack-01", port_count=16,
        labels={
            1: "Optn88",   2: "Optn51",   3: "Optn29",   4: "Opt106",
            5: "Opt133",   6: "Optn144",  7: "Opt60",    8: "Opt94",
            9: "Optn84",  10: "Opt208",  11: "Optn130",  12: "Optn84",
           14: "Optn87",  15: "Optn45",  16: "Optn85",
        },
    ),
    dict(
        id="kvm-unit2", kind="kvm", name="KVM-Unit-2",
        model="Raritan Dominion KX III", ip="10.7.30.115", rack="Rack-06", port_count=8,
        labels={1: "Opt250", 2: "Optn93", 3: "Optn87", 4: "Optn114", 5: "Opt41", 6: "Optn101"},
    ),
    dict(
        id="kvm-unit3", kind="kvm", name="KVM-Unit-3",
        model="Raritan Dominion LX II", ip="10.7.30.53", rack="Rack-05", port_count=8,
        labels={1: "Optn149", 2: "Optn108", 3: "Optn45"},
    ),
]


async def main():
    settings = get_settings()
    await init_db()

    pdu_user = settings.pdu_username
    pdu_pass = settings.pdu_password
    kvm_user = settings.kvm_username
    kvm_pass = settings.kvm_password

    async with AsyncSessionLocal() as db:
        for d in DEVICES:
            labels_str = json.dumps({str(k): v for k, v in d.get("labels", {}).items()})
            existing = await db.get(Device, d["id"])
            if existing:
                existing.labels_json = labels_str
                existing.name = d["name"]
                existing.ip = d["ip"]
                existing.rack = d.get("rack", "")
                print(f"  updated: {d['name']} (labels refreshed)")
            else:
                is_pdu = d["kind"] == "pdu"
                dev = Device(
                    id=d["id"],
                    kind=d["kind"],
                    name=d["name"],
                    model=d.get("model", ""),
                    ip=d["ip"],
                    rack=d.get("rack", ""),
                    port_count=d.get("port_count", 0),
                    labels_json=labels_str,
                    username_enc=encrypt(pdu_user if is_pdu else kvm_user),
                    password_enc=encrypt(pdu_pass if is_pdu else kvm_pass),
                )
                db.add(dev)
                print(f"  added: {d['name']} ({d['ip']})")

        await db.commit()

    print("\nDone. All devices seeded.")


if __name__ == "__main__":
    asyncio.run(main())
