# Floyo Prompt Service

Small local helper for SWAT2. Builds Comfy API prompts from `workflow_json`
**in memory only** — it does **not** write anything to the database.

## What it does

1. Uses a valid stored `workflows.prompt` if shape is correct
2. Repairs stored prompt (adds missing `class_type` from graph nodes)
3. Converts UI `workflow_json` (nodes + links) to API prompt
4. **Optional read-only fallback:** latest successful `workflow_runs.prompt` for that workflow

## Will it slow SWAT?

- Runs locally on your machine (`~8788`)
- Called only at **Preflight** and **Run pending** (not on every UI refresh)
- Results are **cached in memory** for 10 minutes per workflow

## Setup

```bash
cd prompt-service
npm install
cp env.example .env   # optional: for workflow_runs read fallback
npm run dev
```

In `SWAT2/.env`:

```env
FLOYO_PROMPT_SERVICE_URL=http://127.0.0.1:8788/generate-prompt
```

Optional (read-only Supabase fallback — copy from SWAT2 `.env`):

```env
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
```

Restart SWAT2 (`npm run dev`).

## Test

```bash
curl http://127.0.0.1:8788/health
```

Then in SWAT2: Preflight → Run pending on a workflow that failed with "Prompt generation failed" before.
