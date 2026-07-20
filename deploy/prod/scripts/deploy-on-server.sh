#!/usr/bin/env bash
# Run ON the EC2 server inside the repo root (~/SWAT-v2).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"

echo "==> SWAT2 production deploy in $ROOT"

if [[ ! -f "$ROOT/.env" ]]; then
  echo "ERROR: .env missing. Copy deploy/prod/.env.production.example to .env and fill values."
  exit 1
fi

mkdir -p logs

# Build (NEXT_PUBLIC_* vars are baked in from .env)
npm ci
npm run build

if [[ ! -f "$ROOT/.next/standalone/server.js" ]]; then
  echo "ERROR: Build did not produce .next/standalone/server.js"
  echo "       Run: npm run build   and check the output above for errors."
  echo "       Tip: on small EC2 instances run: export NODE_OPTIONS=--max-old-space-size=2048"
  exit 1
fi

# Standalone server reads env from its cwd at runtime
mkdir -p "$ROOT/.next/standalone/.next"
cp -R "$ROOT/.next/static" "$ROOT/.next/standalone/.next/static"
cp -R "$ROOT/public" "$ROOT/.next/standalone/public"
cp "$ROOT/.env" "$ROOT/.next/standalone/.env"

# Prompt service deps
cd "$ROOT/prompt-service"
npm ci --omit=dev
cp "$ROOT/.env" "$ROOT/prompt-service/.env"
cd "$ROOT"

# PM2: stop old SWAT2 processes if present (does not touch gd/em/api)
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
