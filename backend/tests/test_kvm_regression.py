"""
KVM regression tests — baseline commit: 25560de (confirmed working 2026-05-14)

Run on the VM (backend must be running on port 8000, KVMs must be reachable):

    cd /opt/lab-manager/backend
    python -m pytest tests/test_kvm_regression.py -v

If LAB_MANAGER_PASSWORD is set in .env, tests authenticate automatically.
"""

import os
import re
import requests
import pytest
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent.parent / ".env")

BASE_URL = "http://localhost:8000"
_pw = os.getenv("LAB_MANAGER_PASSWORD", "")
AUTH = ("", _pw) if _pw else None

# Confirmed-good baseline — every deploy is compared against this.
# Update this constant when a new baseline is established.
BASELINE_COMMIT = "d4fcc27"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def kvm_devices():
    r = requests.get(f"{BASE_URL}/api/devices", auth=AUTH, timeout=10)
    assert r.status_code == 200, f"Cannot reach backend: {r.status_code} — is it running?"
    kvms = [d for d in r.json() if d["kind"] == "kvm"]
    assert kvms, "No KVM devices found in the database — add devices first"
    return kvms


@pytest.fixture(scope="module")
def reachable_kvms(kvm_devices):
    result = []
    for kvm in kvm_devices:
        r = requests.get(f"{BASE_URL}/api/kvms/{kvm['id']}/status", auth=AUTH, timeout=15)
        if r.status_code == 200 and r.json().get("reachable"):
            result.append(kvm)
    assert result, "No KVM devices are reachable — check network/credentials"
    return result


# ---------------------------------------------------------------------------
# Version check — runs first, always
# ---------------------------------------------------------------------------

def test_version_not_unknown():
    """
    Version must not be 'unknown'.

    'unknown' means backend/version.txt is missing — deploy.sh writes it
    before restarting the service. If this fails, run deploy.sh again.
    """
    r = requests.get(f"{BASE_URL}/api/version", timeout=5)
    assert r.status_code == 200, f"/api/version returned {r.status_code}"
    v = r.json().get("version", "")
    assert v not in ("", "unknown"), (
        "Version is 'unknown' — backend/version.txt was not written. "
        "Run deploy.sh (not just systemctl restart) to fix."
    )
    print(f"\n  Deployed : {v}")
    print(f"  Baseline : {BASELINE_COMMIT}")


def test_backend_version_endpoint():
    """Backend exposes /api/version (public — no auth required)."""
    r = requests.get(f"{BASE_URL}/api/version", timeout=5)
    assert r.status_code == 200
    data = r.json()
    assert "version" in data
    assert data["version"] not in ("", None)
    print(f"\n  deployed commit: {data['version']}")


# ---------------------------------------------------------------------------
# Basic connectivity
# ---------------------------------------------------------------------------

def test_kvm_devices_registered(kvm_devices):
    """At least one KVM is registered in the database."""
    assert len(kvm_devices) >= 1
    print(f"\n  KVMs: {[k['name'] for k in kvm_devices]}")


def test_kvm_status_reachable(reachable_kvms):
    """Each reachable KVM returns a valid status response."""
    for kvm in reachable_kvms:
        r = requests.get(f"{BASE_URL}/api/kvms/{kvm['id']}/status", auth=AUTH, timeout=15)
        assert r.status_code == 200, f"{kvm['name']}: status returned {r.status_code}"
        data = r.json()
        assert data["reachable"], f"{kvm['name']}: marked unreachable"
        assert isinstance(data.get("ports"), list), f"{kvm['name']}: no ports list"
        print(f"\n  {kvm['name']}: {len(data['ports'])} ports")


# ---------------------------------------------------------------------------
# Autologin — core regression (baseline 25560de)
# ---------------------------------------------------------------------------

def test_autologin_redirects_to_same_origin_viewer(reachable_kvms):
    """Browser certificate trust is unnecessary when assets and WS use the proxy."""
    from urllib.parse import urlsplit, parse_qs
    for kvm in reachable_kvms:
        for port in [1, 2]:
            r = requests.get(
                f"{BASE_URL}/api/kvms/{kvm['id']}/autologin?port={port}",
                auth=AUTH, timeout=45, allow_redirects=False,
            )
            assert r.status_code == 302, f"{kvm['name']}: sign-in failed ({r.status_code})"
            location = urlsplit(r.headers["location"])
            assert not location.netloc
            assert location.path == f"/api/kvms/{kvm['id']}/proxy/jsclient/Client.asp"
            fragment = parse_qs(location.fragment)
            assert len(fragment["sessionId"][0]) >= 40
            assert fragment["portNo"] == [str(port)]
            assert r.headers["cache-control"] == "no-store"
            viewer = requests.get(BASE_URL + location.path, auth=AUTH, timeout=45)
            assert viewer.status_code == 200
            assert "window.WebSocket" in viewer.text
            assert "Certificate Setup Required" not in viewer.text


# ---------------------------------------------------------------------------
# In-use tracking
# ---------------------------------------------------------------------------

def test_mark_in_use(reachable_kvms):
    """mark-in-use endpoint returns 200."""
    kvm = reachable_kvms[0]
    r = requests.post(
        f"{BASE_URL}/api/kvms/{kvm['id']}/ports/1/mark-in-use",
        auth=AUTH, timeout=10,
    )
    assert r.status_code == 200
    assert r.json().get("ok") is True


def test_mark_free(reachable_kvms):
    """mark-free endpoint clears all in-use markers and returns 200."""
    kvm = reachable_kvms[0]
    # Mark first, then clear
    requests.post(f"{BASE_URL}/api/kvms/{kvm['id']}/ports/1/mark-in-use",
                  auth=AUTH, timeout=10)
    r = requests.post(f"{BASE_URL}/api/kvms/{kvm['id']}/mark-free",
                      auth=AUTH, timeout=10)
    assert r.status_code == 200
    assert r.json().get("ok") is True
