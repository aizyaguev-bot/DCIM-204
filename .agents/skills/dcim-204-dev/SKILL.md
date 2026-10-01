---
name: dcim-204-dev
description: Development workflow for the DCIM-204 Lab Manager repo (FastAPI backend, React/Vite frontend, Three.js lab-twin) that controls Raritan PX4 PDUs and Dominion KX III / LX II KVMs and tracks rack inventory and barcodes. Use when editing, testing, building, or deploying code in this repository.
---

# DCIM-204 Development

## Layout
- `backend/app/` – FastAPI app: `main.py` (also serves `frontend/dist` and `/twin`), `routers/` (`devices`, `pdus`, `kvms`, `kvm_proxy`, `inventory`), `inventory_store.py`, `crypto.py`, `config.py`
- `backend/tests/` – pytest suite (in-memory SQLite, see `conftest.py`)
- `backend/scripts/` – one-off ops scripts
- `frontend/src/` – React + Vite + Tailwind (`pages/`, `components/`, `api/`)
- `lab-twin/` – standalone Three.js digital twin, no build step. Read `lab-twin/CLAUDE.md` before touching it.
- `docs/barcode-scanning.md` – Scan & Track design and API contract
- `mockup/` – legacy Phase 1 HTML mockup; the README's Phase 1/2 sections are outdated

## Rules
- Secrets come from `.env` in the repo root (`PDU_*`, `KVM_*`, `LAB_MANAGER_MASTER_KEY`, `LAB_MANAGER_PASSWORD`). Never commit `.env`, IPs, or credentials; device passwords are Fernet-encrypted in SQLite (`backend/lab_manager.db`).
- Runtime state JSON in `backend/` (`rack_items.json`, `rack_slots.json`, `rack_positions.json`, `switch_assignments.json`) is gitignored and machine-specific; don't create or commit it.
- Rack-item writes use an ETag: GET `/api/rack-items` returns it, every PUT must send `If-Match`. Preserve `serial_number`, `barcode`, `shelf_position`, `last_seen_at`, `tracking_history`.
- Inventory for the twin lives in `lab-twin/lab-data.json`; never hard-code inventory in JS.
- `frontend/dist/` is committed build output: after frontend source changes run `npm run build` and commit the result. Never hand-edit it.

## Verify changes
Run what matches the files you touched:
1. Backend (no hardware needed):
   `cd backend && python -m pytest tests/ --ignore=tests/test_kvm_regression.py -v`
2. Frontend inventory logic: `cd frontend && npm run test:inventory`
3. Frontend build: `cd frontend && npm run build`
4. Twin: `node --check lab-twin/app.js`

`tests/test_kvm_regression.py` hits the live server and real KVMs; run it only against a deployed instance.

Local dev: `dev.bat` starts uvicorn on :8000 and Vite on :5173.

## Deploy
Production runs on a Linux VM from a git checkout. `deploy.sh` does: `git pull` → unit tests → `npm run build` → write `backend/version.txt` → `sudo systemctl restart lab-manager` → live regression test.
Static-only changes (`lab-twin/`, `frontend/dist/`) need just `git pull` and a hard browser refresh.
Never deploy, restart services, or toggle PDU outlets without explicit user approval.
