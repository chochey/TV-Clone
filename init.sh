#!/bin/bash
# TV-Clone dev environment initializer
# Run at the start of every coding session to verify the environment is healthy

set -e

REPO="/home/blue/Desktop/Repos/TV-Clone"
DEV_PORT=4801
PROD_PORT=4800

echo "=== TV-Clone Dev Init ==="
echo ""

# 1. Show recent git log
echo "--- Recent commits ---"
git -C "$REPO" log --oneline -10
echo ""

# 2. Show current branch
echo "--- Current branch ---"
git -C "$REPO" branch --show-current
echo ""

# 3. Check if dev service is running
echo "--- Dev service status ---"
if systemctl is-active --quiet tvclone-dev.service; then
  echo "tvclone-dev.service: RUNNING on port $DEV_PORT"
else
  echo "tvclone-dev.service: STOPPED — starting..."
  sudo systemctl start tvclone-dev.service
  sleep 3
fi
echo ""

# 4. Smoke test dev server
echo "--- Smoke test (dev) ---"
HEALTH=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:$DEV_PORT/api/health 2>/dev/null || echo "000")
if [ "$HEALTH" = "200" ]; then
  echo "Health check: OK (HTTP 200)"
else
  echo "Health check: FAILED (HTTP $HEALTH) — check journalctl -u tvclone-dev.service"
fi
echo ""

# 5. Show prod service status
echo "--- Prod service status ---"
if systemctl is-active --quiet tvclone-prod.service; then
  echo "tvclone-prod.service: RUNNING on port $PROD_PORT"
else
  echo "tvclone-prod.service: STOPPED"
fi
echo ""

echo "=== Ready. Read claude-progress.txt and feature_list.json before starting work. ==="
echo "=== Always work in dev first. Deploy to prod only when feature is tested. ==="
