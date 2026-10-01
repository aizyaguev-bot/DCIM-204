# DCIM-204 Lab Manager

FastAPI backend (`backend/`), React/Vite frontend (`frontend/`) and a Three.js digital twin (`lab-twin/`) for lab PDUs, KVMs and rack inventory.

- Full workflow, rules and test commands: `.agents/skills/dcim-204-dev/SKILL.md`
- Digital twin conventions: `lab-twin/CLAUDE.md`
- Barcode / Scan & Track contract: `docs/barcode-scanning.md`

Before finishing a change, run the backend unit tests:
`cd backend && python -m pytest tests/ --ignore=tests/test_kvm_regression.py -v`

Never commit `.env`, device IPs or credentials. Never deploy, restart services or toggle PDU outlets without explicit approval.
