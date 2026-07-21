# SWAT2 Production Deploy

Deploy kit for **Swat_Prod** → **swat.floyo.ai** (EC2 `i-0dad2a5f72d33c1c2`).

App code lives in `Swat_Prod/`. This folder (`deploy/prod/`) has Docker, PM2, nginx, and scripts only — no duplicate codebase.

---

## Architecture (prod)

```
Browser → swat.floyo.ai (nginx :80)
              ↓
         Next.js SWAT2 (:3000)  — batch queue, preflight UI
              ↓
         prompt-service (:8788) — baseline trust checks (read-only Supabase)
              ↓
         swat.dispatch.floyo.ai — workflow execution
              ↓
         Supabase prod (swat schema)
```

**Two processes** must run in prod (unlike old SWAT):
1. **swat2** — Next.js standalone
2. **swat2-prompt-service** — baseline / preflight API

---

## Before first deploy — change these

### 1. Environment (`.env`)

Copy template:

```bash
cp deploy/prod/.env.production.example .env
```

| Variable | Local dev | Production |
|----------|-----------|------------|
| `NODE_ENV` | `development` | **`production`** |
| `NEXT_PUBLIC_APP_URL` | `http://localhost:3000` | **`https://swat.floyo.ai`** |
| `NEXT_PUBLIC_MAIN_SITE_DOMAIN` | `https://floyo.ai` | **`https://floyo.ai`** |
| `NEXT_PUBLIC_SUPABASE_COOKIE_DOMAIN` | `localhost` | **`.floyo.ai`** |
| `SUPABASE_COOKIE_DOMAIN` | `localhost` | **`.floyo.ai`** |
| `NEXT_PUBLIC_GLOBAL_DISPATCHER_URL` | local / dispatch.floyo.ai | **`https://swat.dispatch.floyo.ai`** |
| `FLOYO_PROMPT_SERVICE_URL` | `http://127.0.0.1:8788/...` | **`http://127.0.0.1:8788/...`** (same host) |
| `SWAT_BASELINE_MODE` | `prompt_changed` | **`prompt_changed`** |
| `DISPATCHER_BACKEND_TOKEN` | GD `BACKEND_TOKEN` | same secret as this host’s GD |
| `DISPATCHER_TEAM_ID` | Flothisia UUID | your prod team |
| `DISPATCHER_USER_ID` | Floyo user UUID | user in that team for run attribution |

`NEXT_PUBLIC_*` vars are **baked in at build time** — set them in `.env` **before** `npm run build`.

### 2. DNS / nginx

- Point `swat.floyo.ai` → EC2 public IP (`34.233.5.172`)
- Install nginx config:

```bash
sudo cp deploy/prod/nginx.conf /etc/nginx/sites-available/swat2
sudo ln -sf /etc/nginx/sites-available/swat2 /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### 3. Supabase auth redirect URLs

In Supabase dashboard → Authentication → URL configuration, add:

- `https://swat.floyo.ai/**`
- `https://swat.floyo.ai/auth/callback`

### 4. Old SWAT folder on EC2

Current prod runs from `~/SWAT` (old app). Plan:

```bash
# Backup old
mv ~/SWAT ~/SWAT-old-$(date +%Y%m%d)

# New app
mkdir -p ~/swat2
```

Stop old PM2/docker before switching nginx.

---

## Option A — PM2 (recommended, matches your EC2)

### On Mac (build + pack)

```bash
cd Swat_Prod
cp deploy/prod/.env.production.example .env   # fill prod values
bash deploy/prod/scripts/pack-release.sh
```

### Upload + deploy on EC2

```bash
scp deploy/prod/release/swat2-release-*.tar.gz ubuntu@34.233.5.172:~/
ssh ubuntu@34.233.5.172
mkdir -p ~/swat2 && tar -xzf swat2-release-*.tar.gz -C ~/swat2
cd ~/swat2 && bash deploy/prod/scripts/deploy-on-server.sh
```

### Verify

```bash
curl -s http://127.0.0.1:3000/api/health
curl -s http://127.0.0.1:8788/health
pm2 status
```

---

## Option B — Docker

```bash
cd Swat_Prod/deploy/prod
cp .env.production.example .env   # fill values
docker compose up -d --build
```

App on `:3000`. Put nginx in front for TLS/domain.

---

## Post-deploy checklist

- [ ] Login via floyo.ai session works (cookie domain `.floyo.ai`)
- [ ] Preflight / Re-check calls prompt-service (no `baseline: missing` for known-good workflows)
- [ ] Queue dispatches to `swat.dispatch.floyo.ai`
- [ ] `DISPATCHER_BACKEND_TOKEN` / `DISPATCHER_TEAM_ID` / `DISPATCHER_USER_ID` set
- [ ] PM2 survives reboot: `pm2 startup` + `pm2 save`

---

## Updating prod later

```bash
# Mac: rebuild tarball with latest code
bash deploy/prod/scripts/pack-release.sh

# EC2: replace and restart
cd ~/swat2 && bash deploy/prod/scripts/deploy-on-server.sh
```

---

## Files in this folder

| File | Purpose |
|------|---------|
| `.env.production.example` | Prod env template |
| `Dockerfile` | Next.js standalone image |
| `Dockerfile.prompt-service` | Baseline service image |
| `docker-compose.yml` | Both services |
| `nginx.conf` | Reverse proxy for swat.floyo.ai |
| `ecosystem.config.cjs` | PM2 config |
| `scripts/pack-release.sh` | Build tarball on Mac |
| `scripts/deploy-on-server.sh` | PM2 start on EC2 |

---

## Do NOT deploy to prod

- `workflow-backups/` — local DB backup artifacts
- `workflow-updates-*` — batch JSON folders (dev tooling)
- `docs/blocked-workflows*.csv` — analysis exports
- Local `.env` with dev tokens committed to git
