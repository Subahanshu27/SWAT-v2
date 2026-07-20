#!/usr/bin/env bash
# Build a production release tarball from your Mac, ready to upload to EC2.
# Output: deploy/prod/release/swat2-release-YYYYMMDD-HHMMSS.tar.gz
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
OUT_DIR="$ROOT/deploy/prod/release"
STAMP="$(date +%Y%m%d-%H%M%S)"
STAGE="$OUT_DIR/stage-$STAMP"
ARCHIVE="$OUT_DIR/swat2-release-$STAMP.tar.gz"

echo "==> Building SWAT2 release from $ROOT"

if [[ ! -f "$ROOT/.env" ]]; then
  echo "ERROR: $ROOT/.env missing. Copy deploy/prod/.env.production.example and fill prod values first."
  exit 1
fi

cd "$ROOT"
npm ci
npm run build

mkdir -p "$STAGE"
mkdir -p "$STAGE/.next/standalone/.next"
mkdir -p "$STAGE/logs"

# Next standalone bundle
cp -R "$ROOT/.next/standalone/." "$STAGE/.next/standalone/"
cp -R "$ROOT/.next/static" "$STAGE/.next/standalone/.next/static"
cp -R "$ROOT/public" "$STAGE/.next/standalone/public"

# Prompt service (internal baseline API)
cp -R "$ROOT/prompt-service" "$STAGE/prompt-service"
rm -f "$STAGE/prompt-service/.env"

# Deploy configs + lockfiles for server-side npm ci in prompt-service
cp -R "$ROOT/deploy/prod" "$STAGE/deploy/prod"
cp "$ROOT/package.json" "$STAGE/package.json"
cp "$ROOT/package-lock.json" "$STAGE/package-lock.json"

# Runtime env (server copies this to standalone + prompt-service as needed)
cp "$ROOT/.env" "$STAGE/.env"

mkdir -p "$OUT_DIR"
tar -czf "$ARCHIVE" -C "$STAGE" .
rm -rf "$STAGE"

echo ""
echo "Release ready: $ARCHIVE"
echo "Upload to EC2:"
echo "  scp $ARCHIVE ubuntu@YOUR_EC2_IP:~/"
echo "On EC2:"
echo "  tar -xzf swat2-release-*.tar.gz -C ~/swat2 && cd ~/swat2 && bash deploy/prod/scripts/deploy-on-server.sh"
