# SWAT2 (Production)

GitHub / EC2 deploy repo for **SWAT2** — the rebuilt Floyo batch workflow runner at [swat.floyo.ai](https://swat.floyo.ai).

> **Local dev copy:** keep using `../Swat_Prod` on your Mac (with `.env`, workflow batches, backups).  
> **This repo:** clean production code only — safe to push to GitHub and deploy on EC2.

## Stack

- **Next.js 16** — dashboard, batches, preflight, queue
- **prompt-service** — baseline trust checks (read-only Supabase)
- **Supabase** — same prod project, `swat` schema
- **PM2 or Docker** — see `deploy/prod/`

## Quick start (EC2)

```bash
git clone <your-repo-url> ~/swat2
cd ~/swat2
cp deploy/prod/.env.production.example .env   # fill prod values
npm ci
npm run build
cd prompt-service && npm ci --omit=dev && cd ..
bash deploy/prod/scripts/deploy-on-server.sh
```

Full guide: **[deploy/prod/README.md](./deploy/prod/README.md)**

## Environment

Copy and fill:

```bash
cp env.example .env                    # local / generic
cp deploy/prod/.env.production.example .env   # production
```

Required:

| Variable | Purpose |
|----------|---------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Client auth |
| `SUPABASE_SERVICE_ROLE_KEY` | Server admin reads |
| `NEXT_PUBLIC_APP_URL` | `https://swat.floyo.ai` in prod |
| `NEXT_PUBLIC_SUPABASE_COOKIE_DOMAIN` | `.floyo.ai` in prod |
| `NEXT_PUBLIC_GLOBAL_DISPATCHER_URL` | `https://swat.dispatch.floyo.ai` |
| `FLOYO_PROMPT_SERVICE_URL` | `http://127.0.0.1:8788/generate-prompt` |
| `SWAT_BASELINE_MODE` | `prompt_changed` |
| `DISPATCHER_TEAM_ID` | Floyo team UUID |
| `DISPATCHER_AUTH_ACCESS_TOKEN` | Prod JWT (refresh when expired) |

`NEXT_PUBLIC_*` values are embedded at **build time** — set `.env` before `npm run build`.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Local dev server |
| `npm run build` | Production build (standalone) |
| `npm start` | Run production build |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript check |

## Architecture

```
Browser → nginx → Next.js (:3000)
                    ↓
              prompt-service (:8788)  baseline preflight
                    ↓
              swat.dispatch.floyo.ai  workflow execution
                    ↓
              Supabase prod
```

## What's in this repo vs local Swat_Prod

| Included (this repo) | Excluded (local only) |
|----------------------|------------------------|
| App + prompt-service source | `.env` secrets |
| `deploy/prod/` configs | `workflow-backups/` |
| `env.example` | `docs/` CSV exports |
| Database schema | `node_modules/`, `.next/` |

## License

Private — Floyo internal.
