#!/bin/bash
set -e

cd "$(dirname "$0")"

echo "=== Pulling latest code ==="
git pull

echo "=== Installing test dependencies ==="
cd backend
pip install -q -r requirements-test.txt
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
python -m pytest tests/test_kvm_regression.py -v
cd ..

echo ""
echo "=== Deploy complete ==="
git log -1 --oneline
