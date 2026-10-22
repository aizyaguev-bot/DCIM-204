#!/bin/bash
set -e

cd "$(dirname "$0")"

echo "=== Pulling latest code ==="
git pull

echo "=== Installing backend and test dependencies ==="
cd backend
pip install -q -r requirements.txt -r requirements-test.txt
cd ..

echo "=== Running unit tests (pre-deploy gate) ==="
cd backend
python -m pytest tests/ --ignore=tests/test_kvm_regression.py -v
cd ..

echo "=== Building frontend ==="
cd frontend
npm install --silent
npm run build
cd ..

echo "=== Writing version ==="
git rev-parse --short HEAD > backend/version.txt
cat backend/version.txt

echo "=== Restarting backend ==="
sudo systemctl restart lab-manager
sleep 4

echo "=== Running regression tests (live smoke test) ==="
cd backend
# Only these three credentials come from ../.env (values already in the environment win);
# the deploy shell never loads that file.
python - <<'PY'
import os, subprocess, sys
from dotenv import dotenv_values
keys = ("LAB_MANAGER_PASSWORD", "DCIM_TEST_USERNAME", "DCIM_TEST_PASSWORD")
env = {k: v for k, v in dotenv_values("../.env").items() if k in keys and v}
env.update(os.environ)
env.update(DCIM_LIVE_KVM_TESTS="1", DCIM_TEST_BASE_URL="http://localhost:8000")
sys.exit(subprocess.call([sys.executable, "-m", "pytest", "tests/test_kvm_regression.py", "-v"], env=env))
PY
cd ..

echo ""
echo "=== Deploy complete ==="
git log -1 --oneline
