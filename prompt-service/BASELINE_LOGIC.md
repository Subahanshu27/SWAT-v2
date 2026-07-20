# SWAT Baseline Classification Logic

## Overview
The prompt-service classifies each workflow before SWAT dispatches it to the GPU.
This prevents wasting dispatcher calls on workflows that are guaranteed to fail.

## Data Sources
- `workflows.workflow_json` — the published blueprint (from Supabase)
- `workflows.prompt` — stored API prompt (used when preflight sends `workflow_id` only and no runs exist yet)
- `workflow_runs.prompt` — the actual GPU payload from past runs (fetched by prompt-service)
- `workflow_runs` metadata — success/failure status, timestamps

## Classification Flow

```
Workflow arrives for preflight
        │
        ▼
  Fetch last N runs from workflow_runs
        │
        ▼
  Any successful runs with unchanged workflow_json?
       │               │
      YES              NO
       │               └──▶ UNVERIFIED (no trusted baseline)
       ▼
  "Trusted" baseline = most recent successful run with unchanged workflow_json
        │
        ▼
  Compare current published prompt vs trusted baseline prompt
       │                    │
    IDENTICAL            DIFFERENT
       │                    └──▶ Has workflow_json also changed?
       │                            │           │
       │                           YES          NO
       │                            │           └──▶ VERIFIED_UNCHANGED_INPUT_CHANGED (stale)
       │                            └──▶ VERIFIED_CHANGED (stale)
       ▼
  Check for outdated infra fields
  (trusted prompt missing fields that recent graph-stable runs have)
       │              │
    FIELDS OK      MISSING FIELDS
       │              └──▶ PROMPT_BASELINE_OUTDATED
       ▼
  Check #community_inputs/ file references exist in file_system_items
  (full_path e.g. community_inputs/abc/file.png — NOT a Supabase Storage bucket)
       │              │
    ALL EXIST      MISSING FILES
       │              └──▶ COMMUNITY_INPUT_MISSING
       ▼
  VERIFIED_UNCHANGED_INPUT_UNCHANGED ✅ (queueable)
```

## "Outdated" Detection Detail
- Compares the trusted prompt's field set against recent runs that have the same graph structure
- Ignores user-varying fields that are expected to differ between runs:
  - Default ignore list: `image`, `seed`, `text`, `noise_seed`, `rand_seed`
  - Configurable via `config/baseline-ignore-fields.json` (see below)
- If trusted prompt is MISSING fields that recent stable runs HAVE → outdated
- Example: Flux Inpaint baseline from May was missing `device_mode` field added in June

## Configurable Ignore Fields
File: `prompt-service/config/baseline-ignore-fields.json`

Maps workflow type → fields to ignore during outdated detection.
`_default` applies when no specific type match is found.

Workflow type is inferred from node `class_type` values in `workflow_json` (flux_inpaint, nano_banana, seedance, etc.).

## How to Fix Each Category

| Category | User Action |
|---|---|
| Stale (input changed) | Run + Publish the workflow in Floyo editor |
| Stale (graph changed) | Run + Publish the workflow in Floyo editor |
| Unverified | Run + Publish the workflow in Floyo editor |
| Outdated | Run + Publish the workflow in Floyo editor |
| Community input missing | Re-upload the missing file in Floyo editor, then Run + Publish |

**Important:** Manual API paste into `workflows.prompt` does NOT work.
It bypasses `workflow_runs` and the baseline will still mismatch.
The ONLY reliable fix is Run + Publish through the Floyo UI.

## Cache Behavior
- prompt-service caches responses in RAM (see `lib/cache.js`)
- TTL: 10 minutes for trusted results, 5 minutes for blocked results
- Key: hash of `workflow_id + workflow_json + prompt + mode`
- Cache stats available at `GET /cache/stats`
- Clear all: `POST /cache/clear`
- Clear one workflow: `POST /cache/clear-workflow` with `{ "workflow_id": "..." }`

## Performance
- Parallel preflight with configurable concurrency (`SWAT_PREFLIGHT_CONCURRENCY`, default 8)
- Smart pagination stop when trusted + 30 recent runs found
- Cache prevents redundant Supabase calls within TTL window

## Dispatcher Retry
SWAT retries dispatcher calls once on 5xx or network timeout (not on 4xx).
Retry metadata is stored in `error_details.dispatch_attempts` and `error_details.retried_from`.
