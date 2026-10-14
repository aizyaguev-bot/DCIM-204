"""
KVM regression tests — baseline commit: 25560de (confirmed working 2026-05-14)

Run on the VM (backend must be running on port 8000, KVMs must be reachable):

    cd /opt/lab-manager/backend
    python -m pytest tests/test_kvm_regression.py -v

Authentication:
  Accounts mode: set DCIM_TEST_USERNAME and DCIM_TEST_PASSWORD (an Operator or
  Admin account). Tests sign in via /api/auth/login and send the session
  cookie plus the X-DCIM-CSRF header.
  Legacy mode: if LAB_MANAGER_PASSWORD is set in .env, HTTP Basic auth is used.
Tests are skipped when the backend is unreachable or requires credentials
that were not provided. DCIM_TEST_BASE_URL overrides http://localhost:8000.
"""

import os
import re
import requests
import pytest
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent.parent / ".env")

BASE_URL = os.getenv("DCIM_TEST_BASE_URL", "http://localhost:8000").rstrip("/")
_pw = os.getenv("LAB_MANAGER_PASSWORD", "")
AUTH = ("", _pw) if _pw else None
ACCOUNT_USERNAME = os.getenv("DCIM_TEST_USERNAME", "")
ACCOUNT_PASSWORD = os.getenv("DCIM_TEST_PASSWORD", "")

# Confirmed-good baseline — every deploy is compared against this.
# Update this constant when a new baseline is established.
BASELINE_COMMIT = "d4fcc27"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def server():
    try:
        requests.get(f"{BASE_URL}/api/version", timeout=5)
    except requests.RequestException as exc:
        pytest.skip(f"Backend not reachable at {BASE_URL} ({type(exc).__name__})")
    return BASE_URL


@pytest.fixture(scope="module")
def api(server):
    """A requests session authenticated for accounts mode or legacy Basic auth."""
    session = requests.Session()
    if ACCOUNT_USERNAME and ACCOUNT_PASSWORD:
        r = session.post(f"{BASE_URL}/api/auth/login", timeout=15,
                         json={"username": ACCOUNT_USERNAME, "password": ACCOUNT_PASSWORD})
        if r.status_code != 200:
            pytest.fail(f"Sign-in as DCIM_TEST_USERNAME failed: HTTP {r.status_code}")
        session.headers["X-DCIM-CSRF"] = r.json()["csrf_token"]
    elif AUTH:
        session.auth = AUTH
    r = session.get(f"{BASE_URL}/api/devices", timeout=10)
    if r.status_code == 401 and not (ACCOUNT_USERNAME and ACCOUNT_PASSWORD) and not AUTH:
        pytest.skip("Backend requires sign-in: set DCIM_TEST_USERNAME/DCIM_TEST_PASSWORD "
                    "(accounts) or LAB_MANAGER_PASSWORD (legacy)")
    yield session
    session.close()


@pytest.fixture(scope="module")
def kvm_devices(api):
    r = api.get(f"{BASE_URL}/api/devices", timeout=10)
    assert r.status_code == 200, f"Cannot list devices: HTTP {r.status_code}"
    kvms = [d for d in r.json() if d["kind"] == "kvm"]
    assert kvms, "No KVM devices found in the database — add devices first"
    return kvms


@pytest.fixture(scope="module")
def reachable_kvms(api, kvm_devices):
    result = []
    for kvm in kvm_devices:
        r = api.get(f"{BASE_URL}/api/kvms/{kvm['id']}/status", timeout=15)
        if r.status_code == 200 and r.json().get("reachable") and not r.json().get("error"):
            result.append(kvm)
    assert result, "No KVM devices are reachable — check network/credentials"
    return result


# ---------------------------------------------------------------------------
# Version check — runs first, always
# ---------------------------------------------------------------------------

def test_version_not_unknown(server):
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


def test_backend_version_endpoint(server):
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


def test_kvm_status_reachable(api, reachable_kvms):
    """Each reachable KVM returns a valid status response."""
    for kvm in reachable_kvms:
        r = api.get(f"{BASE_URL}/api/kvms/{kvm['id']}/status", timeout=15)
        assert r.status_code == 200, f"{kvm['name']}: status returned {r.status_code}"
        data = r.json()
        assert data["reachable"], f"{kvm['name']}: marked unreachable"
        assert isinstance(data.get("ports"), list), f"{kvm['name']}: no ports list"
        print(f"\n  {kvm['name']}: {len(data['ports'])} ports")


def test_kvm_status_reports_credential_failures(api, kvm_devices):
    """A KVM that answers but refuses its saved credentials says so explicitly."""
    for kvm in kvm_devices:
        data = api.get(f"{BASE_URL}/api/kvms/{kvm['id']}/status", timeout=15).json()
        if data.get("error") == "Device API authentication failed":
            assert data["reachable"] is True
            print(f"\n  {kvm['name']}: saved credentials rejected")


# ---------------------------------------------------------------------------
# Autologin — core regression (baseline 25560de)
# ---------------------------------------------------------------------------

def test_autologin_redirects_to_same_origin_viewer(api, reachable_kvms):
    """Browser certificate trust is unnecessary when assets and WS use the proxy."""
    from urllib.parse import urlsplit, parse_qs
    for kvm in reachable_kvms:
        for port in [1, 2]:
            r = api.get(
                f"{BASE_URL}/api/kvms/{kvm['id']}/autologin?port={port}",
                timeout=45, allow_redirects=False,
            )
            assert r.status_code == 302, f"{kvm['name']}: sign-in failed ({r.status_code})"
            location = urlsplit(r.headers["location"])
            assert not location.netloc
            assert re.fullmatch(rf"/api/kvms/{re.escape(kvm['id'])}/proxy/~[^/]+/jsclient/Client\.asp", location.path)
            fragment = parse_qs(location.fragment)
            assert len(fragment["sessionId"][0]) >= 40
            assert fragment["portNo"] == [str(port)]
            assert r.headers["cache-control"] == "no-store"
            viewer = api.get(BASE_URL + location.path, timeout=45)
            assert viewer.status_code == 200
            assert "window.WebSocket" in viewer.text
            assert "Certificate Setup Required" not in viewer.text


# ---------------------------------------------------------------------------
# In-use tracking
# ---------------------------------------------------------------------------

def test_mark_in_use(api, reachable_kvms):
    """mark-in-use endpoint returns 200."""
    kvm = reachable_kvms[0]
    r = api.post(f"{BASE_URL}/api/kvms/{kvm['id']}/ports/1/mark-in-use", timeout=10)
    assert r.status_code == 200
    assert r.json().get("ok") is True


def test_mark_free(api, reachable_kvms):
    """mark-free endpoint clears all in-use markers and returns 200."""
    kvm = reachable_kvms[0]
    # Mark first, then clear
    api.post(f"{BASE_URL}/api/kvms/{kvm['id']}/ports/1/mark-in-use", timeout=10)
    r = api.post(f"{BASE_URL}/api/kvms/{kvm['id']}/mark-free", timeout=10)
    assert r.status_code == 200
    assert r.json().get("ok") is True
