import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { mapPool } from '@/lib/helpers/async-pool';
import { chunkArray } from '@/lib/helpers/chunk';
import { preflightReason } from '@/lib/helpers/preflight-messages';
import { env } from '@/lib/config/env';
import { getWorkflowDefinitions } from './workflow.service';
import { resolvePrompt } from './prompt.service';
import { ErrorCategory, PreflightItem, PreflightResult } from '@/types';

/** Load + preflight in chunks to cap memory and DB payload size on large batches. */
const PREFLIGHT_DEF_CHUNK = 50;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function preflightConcurrency(total: number): number {
  // Large batches: cap parallel prompt-service calls to reduce transient Supabase misses.
  if (total >= 200) return Math.min(env.preflight.concurrency, 4);
  if (total >= 100) return Math.min(env.preflight.concurrency, 6);
  return env.preflight.concurrency;
}

async function resolvePromptForPreflight(
  workflowId: string,
  workflowJson: unknown,
  storedPrompt: unknown
) {
  const opts = {
    workflowId,
    workflowJson,
    storedPrompt,
    baselineCheckOnly: !!env.promptService.url,
  };

  let resolved = await resolvePrompt(opts);
  // Transient prompt-service / Supabase misses often flip to "missing" — retry before blocking.
  for (let attempt = 1; attempt < 3 && resolved.baseline === 'missing'; attempt++) {
    await sleep(250 * attempt);
    resolved = await resolvePrompt(opts);
  }
  return resolved;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

async function preflightOne(
  workflowId: string,
  def: Awaited<ReturnType<typeof getWorkflowDefinitions>>[number] | undefined
): Promise<PreflightItem> {
  try {
    if (!def) {
      return {
        workflowId,
        name: 'Unknown workflow',
        queueable: false,
        category: 'invalid_workflow_json',
        reason: preflightReason('invalid_workflow_json'),
        promptSource: 'none',
      };
    }

    const name = def.name || 'Untitled workflow';
    const workflowJson = parseMaybeJson(def.workflow_json);

    if (!workflowJson || typeof workflowJson !== 'object') {
      return {
        workflowId,
        name,
        queueable: false,
        category: 'invalid_workflow_json',
        reason: preflightReason('invalid_workflow_json'),
        promptSource: 'none',
      };
    }

    const resolved = await resolvePromptForPreflight(workflowId, workflowJson, def.prompt);

    if (!resolved.prompt) {
      const category: ErrorCategory = 'prompt_generation_failed';
      return {
        workflowId,
        name,
        queueable: false,
        category,
        reason: resolved.reason || preflightReason(category),
        promptSource: 'none',
        baseline: resolved.baseline,
      };
    }

    if (
      resolved.baseline === 'missing' ||
      resolved.baseline === 'stale' ||
      resolved.baseline === 'outdated' ||
      resolved.baseline === 'community_input_missing'
    ) {
      const category: ErrorCategory =
        resolved.baseline === 'missing'
          ? 'prompt_baseline_missing'
          : resolved.baseline === 'outdated'
            ? 'prompt_baseline_outdated'
            : resolved.baseline === 'community_input_missing'
              ? 'community_input_missing'
              : 'prompt_baseline_stale';

      return {
        workflowId,
        name,
        queueable: false,
        category,
        reason: preflightReason(category),
        promptSource: resolved.source,
        baseline: resolved.baseline,
      };
    }

    return {
      workflowId,
      name,
      queueable: true,
      category: 'none',
      promptSource: resolved.source,
      baseline: resolved.baseline,
    };
  } catch (err) {
    return {
      workflowId,
      name: def?.name || 'Untitled workflow',
      queueable: false,
      category: 'infra_error',
      reason: (err as Error).message || preflightReason('infra_error'),
      promptSource: 'none',
    };
  }
}

/**
 * Validate workflows before queueing so SWAT does not send known-bad payloads
 * to the dispatcher. Runs checks in parallel (bounded concurrency).
 */
export async function preflightWorkflows(
  client: SupabaseClient,
  workflowIds: string[],
  workflowDb: SupabaseClient = client,
  options?: { batchId?: string; logProgress?: boolean; requestId?: string }
): Promise<PreflightResult> {
  const total = workflowIds.length;
  const log = options?.logProgress !== false && total > 0;
  const label = options?.batchId ? `batch ${options.batchId}` : 'preflight';
  const req = options?.requestId ? `req=${options.requestId} ` : '';
  const concurrency = preflightConcurrency(total);

  if (log) {
    console.log(
      `[SWAT preflight] ${req}Started — ${total} workflows (${label}, concurrency ${concurrency})`
    );
  }

  const items: PreflightItem[] = [];
  let queueableSoFar = 0;

  for (const idChunk of chunkArray(workflowIds, PREFLIGHT_DEF_CHUNK)) {
    const defs = await getWorkflowDefinitions(workflowDb, idChunk);
    const byId = new Map(defs.map((d) => [d.id, d]));

    const chunkItems = await mapPool(idChunk, concurrency, (workflowId) =>
      preflightOne(workflowId, byId.get(workflowId))
    );
    items.push(...chunkItems);
    queueableSoFar += chunkItems.filter((i) => i.queueable).length;

    if (log) {
      const done = items.length;
      const blockedSoFar = done - queueableSoFar;
      console.log(
        `[SWAT preflight] ${req}${done}/${total} — queueable: ${queueableSoFar}, blocked: ${blockedSoFar}`
      );
    }
  }

  const queueable = queueableSoFar;
  if (log) {
    console.log(
      `[SWAT preflight] ${req}Complete — ${items.length}/${total} — queueable: ${queueable}, blocked: ${items.length - queueable}`
    );
  }

  return {
    total: items.length,
    queueable,
    blocked: items.length - queueable,
    items,
  };
}

/** Re-run preflight for a single workflow (used by Re-check button). */
export async function preflightSingleWorkflow(
  client: SupabaseClient,
  workflowId: string,
  workflowDb: SupabaseClient = client
): Promise<PreflightItem> {
  const defs = await getWorkflowDefinitions(workflowDb, [workflowId]);
  return preflightOne(workflowId, defs[0]);
}
