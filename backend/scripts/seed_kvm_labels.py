#!/usr/bin/env python3
"""
Seed KVM port labels from the known port assignments captured 2026-05-14.

Run on the VM:
    cd /opt/lab-manager/backend
    python scripts/seed_kvm_labels.py
"""
import os
import sys

import requests
from dotenv import load_dotenv
from pathlib import Path

load_dotenv(Path(__file__).parent.parent.parent / ".env")

BASE = "http://localhost:8000"
_pw = os.getenv("LAB_MANAGER_PASSWORD", "")
AUTH = ("", _pw) if _pw else None

# Port labels by device IP.
# Keys = port number (string), values = label.
# Ports with generic names (Dominion_KX3_PortX) or no name ("0") are omitted.
LABELS = {
    "10.7.30.53": {
        "1": "optn108",
        "2": "optn45",
        "8": "opt",
    },
    "10.7.30.115": {
        "2": "OPTN101",
        "3": "OPTN93",
        "4": "OPTN29",
        "6": "OPT41",
        "7": "OPTN87",
        "8": "OPT250",
    },
    "10.7.30.49": {
        "1":  "OPTN88",
        "2":  "OPTN51",
        "3":  "OPTN29",
        "4":  "OPT106",
        "6":  "OPTN144",
        "7":  "OPT60",
        "8":  "OPT94",
        "9":  "OPTN84",
        "10": "OPT208",
        "11": "OPTN130",
        "12": "OPTN84",
        "14": "OPTN87",
        "15": "OPT133",
        "16": "OPTN85",
    },
}


def main():
    try:
        devices = requests.get(f"{BASE}/api/devices/", auth=AUTH, timeout=5).json()
    except Exception as e:
        print(f"Cannot reach backend: {e}")
        sys.exit(1)

    kvms = {d["ip"]: d for d in devices if d["kind"] == "kvm"}

    for ip, labels in LABELS.items():
        dev = kvms.get(ip)
        if not dev:
            print(f"  SKIP  {ip} — no KVM with that IP in the database")
            continue
        r = requests.patch(
            f"{BASE}/api/devices/{dev['id']}/labels",
            json=labels,
            auth=AUTH,
            timeout=5,
        )
        if r.status_code == 200:
            print(f"  OK    {ip}  ({dev['name']})  — {len(labels)} labels set")
        else:
            print(f"  FAIL  {ip}  ({dev['name']})  — HTTP {r.status_code}: {r.text}")


if __name__ == "__main__":
    main()
