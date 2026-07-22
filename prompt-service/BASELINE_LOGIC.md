# SWAT Baseline Classification Logic

## Overview
The prompt-service classifies each workflow before SWAT dispatches it to the GPU.
This prevents wasting dispatcher calls on workflows that are guaranteed to fail.

## Sources of truth

| Concern | Source |
|---------|--------|
| **Dispatch prompt / graph** | `workflows.prompt` + `workflows.workflow_json` (same as Floyo UI) |
| **Baseline / drift check** | `workflow_runs` (trusted successful runs) — compare only, never dispatch |
| **File existence** | Paths in the **catalog** prompt vs `file_system_items` |

## Classification Flow

```
Workflow arrives for preflight / queue
        │
        ▼
  Load published catalog from workflows table
  (prompt + workflow_json)  ← DISPATCH SOURCE
        │
        ▼
  Fetch trusted / recent runs from workflow_runs
  (baseline gate only)
        │
        ▼
  Any successful trusted run?
       │               │
      YES              NO
       │               └──▶ UNVERIFIED / missing (block)
       ▼
  Classify vs published graph (prompt_changed / graph match)
       │                    │
    EXACT                STALE / OUTDATED
       │                    └──▶ BLOCK (Run + Publish)
       ▼
  Check file refs in CATALOG prompt:
    #community_inputs/*  AND  #inputs/*
  against file_system_items
       │              │
    ALL EXIST      MISSING FILES
       │              └──▶ invalid_prompt_files (block — not queueable)
       ▼
  QUEUEABLE ✅
  Dispatch uses workflows.prompt (NOT workflow_runs.prompt)
```

## Why not dispatch from workflow_runs?

Older SWAT2 used the golden-run prompt for dispatch. That caused false failures when
`workflows` had been updated to `#community_inputs/` but the trusted run still
referenced `#inputs/`. Dispatch must match what the UI loads: the **workflows** row.

`workflow_runs` remains the drift/trust check only.

## File check detail

- Extracts both `#community_inputs/` and `#inputs/` from the catalog prompt
- Looks up `file_system_items.full_path` (strip leading `#`)
- `community_inputs/...` → require `team_id IS NULL` (published)
- `inputs/...` → any non-deleted row with storage_object_id
- Missing → block with category `invalid_prompt_files` (baseline `community_input_missing`)

## How to Fix Each Category

| Category | User Action |
|---|---|
| Stale / outdated / unverified | Run + Publish in the Floyo editor |
| invalid_prompt_files / missing files | Fix or re-upload referenced files, then Run + Publish |
| Manual paste into `workflows.prompt` | Does NOT refresh baseline — still need a trusted run |

## Cache Behavior
- Key includes catalog prompt fingerprint so Publish (prompt change) invalidates naturally
- TTL: 10 minutes trusted, 5 minutes blocked
- Clear one workflow: `POST /cache/clear-workflow` `{ "workflow_id": "..." }`
- SWAT Re-check clears cache for that workflow before re-running preflight

## Dispatcher Retry
SWAT retries dispatcher calls once on 5xx or network timeout (not on 4xx).
Retry metadata is stored in `error_details.dispatch_attempts` and `error_details.retried_from`.
