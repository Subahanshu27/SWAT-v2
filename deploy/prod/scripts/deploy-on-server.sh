#!/usr/bin/env bash
# Run ON the EC2 server inside the unpacked release directory (~/swat2).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"

echo "==> SWAT2 production deploy in $ROOT"

if [[ ! -f "$ROOT/.env" ]]; then
  echo "ERROR: .env missing. Copy deploy/prod/.env.production.example to .env and fill values."
  exit 1
fi

mkdir -p logs

# Prompt service deps
cd "$ROOT/prompt-service"
npm ci --omit=dev
cp "$ROOT/.env" "$ROOT/prompt-service/.env"
cd "$ROOT"

# PM2: stop old processes if present
pm2 delete swat2 swat2-prompt-service 2>/dev/null || true

# Start both services
pm2 start "$ROOT/deploy/prod/ecosystem.config.cjs" --env production
pm2 save

echo ""
echo "SWAT2 running:"
echo "  App:            http://127.0.0.1:3000  (proxy via nginx -> swat.floyo.ai)"
echo "  Prompt service: http://127.0.0.1:8788"
echo ""
echo "Health checks:"
echo "  curl -s http://127.0.0.1:3000/api/health"
echo "  curl -s http://127.0.0.1:8788/health"
echo ""
echo "Logs: pm2 logs swat2"
echo "      pm2 logs swat2-prompt-service"
