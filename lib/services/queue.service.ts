import 'server-only';
import { baselineBlockCategory, shouldBlockForBaseline } from '@/lib/helpers/baseline';
import { preflightReason } from '@/lib/helpers/preflight-messages';
import type { SupabaseClient } from '@supabase/supabase-js';
import { env } from '@/lib/config/env';
import { buildDispatcherAuth } from '@/lib/helpers/dispatcher-auth';
import { getWorkflowDefinitions } from './workflow.service';
import { resolvePrompt } from './prompt.service';
import { recomputeBatchStatus } from './batch.service';
import { ErrorCategory, WorkflowStatus } from '@/types';

export interface QueueResult {
  workflowId: string;
  success: boolean;
  category: ErrorCategory;
  error?: string;
  runId?: string;
  attempts?: number;
  retriedFrom?: string;
}

interface DispatchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  data: unknown;
  promptId?: string;
}

async function dispatch(payload: {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}): Promise<DispatchResponse> {
  const response = await fetch(payload.url, {
    method: 'POST',
    headers: payload.headers,
    body: JSON.stringify(payload.body),
  });

  const contentType = response.headers.get('content-type') || '';
  const responseData = contentType.includes('application/json')
    ? await response.json()
    : await response.text();

  const promptId =
    responseData && typeof responseData === 'object' && !Array.isArray(responseData)
      ? (responseData as { prompt_id?: string }).prompt_id
      : undefined;

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    data: responseData,
    promptId,
  };
}

async function dispatchWithRetry(
  payload: {
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  },
  maxRetries = 1,
  delayMs = 5000
): Promise<DispatchResponse & { attempts: number; retriedFrom?: string }> {
  let lastError: Error | null = null;
  let lastStatus = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await dispatch(payload);
      if (result.ok) {
        return {
          ...result,
          attempts: attempt + 1,
          ...(attempt > 0 && lastError ? { retriedFrom: lastError.message } : {}),
        };
      }

      lastStatus = result.status;
      const isRetryable = result.status >= 500 || result.status === 0;
      if (attempt < maxRetries && isRetryable) {
        console.log(
          `[SWAT] Dispatch attempt ${attempt + 1} failed (status ${result.status}), retrying in ${delayMs}ms...`
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      return { ...result, attempts: attempt + 1 };
    } catch (err) {
      lastError = err as Error;
      lastStatus = 0;
      if (attempt < maxRetries) {
        console.log(
          `[SWAT] Dispatch attempt ${attempt + 1} failed (status ${lastStatus}), retrying in ${delayMs}ms...`
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      throw err;
    }
  }

  throw lastError || new Error(`Dispatch failed with status ${lastStatus}`);
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

async function setWorkflowStatus(
  client: SupabaseClient,
  batchWorkflowId: string,
  status: WorkflowStatus,
  extra: Record<string, unknown> = {}
): Promise<void> {
  await client
    .schema('swat')
    .from('batch_workflows')
    .update({ status, ...extra })
    .eq('id', batchWorkflowId);
}

async function markFailed(
  client: SupabaseClient,
  batchWorkflowId: string,
  category: ErrorCategory,
  errorMessage: string,
  details: Record<string, unknown>
): Promise<void> {
  await setWorkflowStatus(client, batchWorkflowId, 'failed', {
    completed_at: new Date().toISOString(),
    error_details: { ...details, error_category: category, error_message: errorMessage },
  });
}

/**
 * Mark a workflow as "blocked": it was NOT sent to the dispatcher because there
 * is no trusted, current prompt baseline to test against. This is deliberately
 * distinct from 'failed' so a missing/stale baseline is never mistaken for a
 * genuine workflow regression.
 *
 * Falls back to 'failed' (keeping the baseline error_category) if the database
 * status constraint has not yet been migrated to allow 'blocked'.
 */
async function markBlocked(
  client: SupabaseClient,
  batchWorkflowId: string,
  category: ErrorCategory,
  errorMessage: string,
  details: Record<string, unknown>
): Promise<void> {
  const errorDetails = { ...details, error_category: category, error_message: errorMessage };
  const { error } = await client
    .schema('swat')
    .from('batch_workflows')
    .update({ status: 'blocked', completed_at: new Date().toISOString(), error_details: errorDetails })
    .eq('id', batchWorkflowId);

  if (error) {
    await setWorkflowStatus(client, batchWorkflowId, 'failed', {
      completed_at: new Date().toISOString(),
      error_details: errorDetails,
    });
  }
}

function parseSequenceDelayMs(sequence?: string): number {
  if (!sequence) return 1000;
  const match = sequence.match(/^(\d+)\s+Each\s+Seconds?$/i);
  if (match?.[1]) return parseInt(match[1], 10) * 1000;
  return 1000;
}

/**
 * Queue every workflow in a batch.
 *
 * For each workflow we:
 *  1. Resolve a valid API prompt (service or validated stored prompt).
 *  2. Block + categorize anything that cannot produce a valid prompt, instead
 *     of letting the dispatcher reject it as a fake "genuine" error.
 *  3. Send valid ones to the dispatcher and record the prompt_id as run_id.
 */
export async function queueBatch(
  client: SupabaseClient,
  batchId: string,
  workflowIds: string[],
  sequence?: string,
  workflowDb: SupabaseClient = client
): Promise<QueueResult[]> {
  if (!workflowIds.length) return [];
  if (!env.dispatcher.url) {
    return workflowIds.map((id) => ({
      workflowId: id,
      success: false,
      category: 'infra_error',
      error: 'Dispatcher URL is not configured (NEXT_PUBLIC_GLOBAL_DISPATCHER_URL)',
    }));
  }

  const dispatcherUrl = `${env.dispatcher.url}/api/prompt`;
  const delayMs = parseSequenceDelayMs(sequence);

  const { data: bwRows, error: bwError } = await client
    .schema('swat')
    .from('batch_workflows')
    .select('id, workflow_id')
    .eq('batch_id', batchId)
    .in('workflow_id', workflowIds);
  if (bwError) throw bwError;

  const batchWorkflowIdByWorkflowId = new Map<string, string>();
  (bwRows ?? []).forEach((r: { id: string; workflow_id: string }) =>
    batchWorkflowIdByWorkflowId.set(r.workflow_id, r.id)
  );

  const defs = await getWorkflowDefinitions(workflowDb, workflowIds);
  const defById = new Map(defs.map((d) => [d.id, d]));

  const results: QueueResult[] = [];

  for (let i = 0; i < workflowIds.length; i++) {
    const workflowId = workflowIds[i];
    const batchWorkflowId = batchWorkflowIdByWorkflowId.get(workflowId);
    const def = defById.get(workflowId);

    if (!batchWorkflowId) {
      results.push({
        workflowId,
        success: false,
        category: 'infra_error',
        error: 'No batch_workflow row found',
      });
      continue;
    }

    if (!def) {
      await markFailed(client, batchWorkflowId, 'invalid_workflow_json', 'Workflow not found', {
        workflow_id: workflowId,
        batch_workflow_id: batchWorkflowId,
        timestamp: new Date().toISOString(),
      });
      results.push({ workflowId, success: false, category: 'invalid_workflow_json', error: 'Workflow not found' });
      continue;
    }

    const workflowJson = parseMaybeJson(def.workflow_json);
    if (!workflowJson || typeof workflowJson !== 'object') {
      await markFailed(client, batchWorkflowId, 'invalid_workflow_json', 'workflow_json is missing or invalid', {
        workflow_id: workflowId,
        batch_workflow_id: batchWorkflowId,
        timestamp: new Date().toISOString(),
      });
      results.push({ workflowId, success: false, category: 'invalid_workflow_json', error: 'Invalid workflow_json' });
      continue;
    }

    const resolved = await resolvePrompt({
      workflowId,
      workflowJson,
      storedPrompt: def.prompt,
    });
    if (!resolved.prompt) {
      await markFailed(
        client,
        batchWorkflowId,
        'prompt_generation_failed',
        resolved.reason || 'Could not resolve a valid API prompt',
        {
          workflow_id: workflowId,
          batch_workflow_id: batchWorkflowId,
          prompt_source: resolved.source,
          timestamp: new Date().toISOString(),
        }
      );
      results.push({
        workflowId,
        success: false,
        category: 'prompt_generation_failed',
        error: resolved.reason,
      });
      continue;
    }

    // Block stale/outdated baselines; missing may queue when SWAT_QUEUE_UNVERIFIED is enabled.
    if (shouldBlockForBaseline(resolved.baseline, env.swat.queueUnverifiedMissing)) {
      const category = baselineBlockCategory(resolved.baseline!);
      const reason = preflightReason(category);
      await markBlocked(client, batchWorkflowId, category, reason, {
        workflow_id: workflowId,
        batch_workflow_id: batchWorkflowId,
        prompt_source: resolved.source,
        baseline: resolved.baseline,
        detail: resolved.reason,
        timestamp: new Date().toISOString(),
      });
      results.push({ workflowId, success: false, category, error: reason });
      continue;
    }

    await setWorkflowStatus(client, batchWorkflowId, 'queued', {
      error_details: null,
      completed_at: null,
      run_id: null,
      started_at: null,
      duration: null,
      execution_time: null,
      time_in_queue: null,
    });

    const dispatcherAuth = await buildDispatcherAuth(workflowDb, workflowId);
    if (!dispatcherAuth.ready) {
      await markFailed(
        client,
        batchWorkflowId,
        'infra_error',
        dispatcherAuth.error || 'Dispatcher auth is not configured',
        {
          workflow_id: workflowId,
          batch_workflow_id: batchWorkflowId,
          dispatcher_url: dispatcherUrl,
          timestamp: new Date().toISOString(),
        }
      );
      results.push({
        workflowId,
        success: false,
        category: 'infra_error',
        error: dispatcherAuth.error || 'Dispatcher auth is not configured',
      });
      continue;
    }

    try {
      const headers: Record<string, string> = {
        ...dispatcherAuth.headers,
        'Content-Type': 'application/json',
      };

      const dispatchResult = await dispatchWithRetry({
        url: dispatcherUrl,
        headers,
        body: {
          client_id: workflowId,
          name: def.name || `Workflow ${workflowId}`,
          workflow: workflowJson,
          batch_index: 0,
          workflow_id: workflowId,
          prompt: resolved.prompt,
        },
      });

      const { ok, status, statusText, data: responseData, promptId, attempts, retriedFrom } =
        dispatchResult;

      if (!ok) {
        const isInfra = [401, 403, 408, 429, 500, 502, 503, 504].includes(status);
        const category: ErrorCategory = isInfra ? 'infra_error' : 'genuine_workflow_error';
        const errorMessage =
          typeof responseData === 'string'
            ? responseData
            : (responseData as { error?: string })?.error || `HTTP ${status}`;

        await markFailed(client, batchWorkflowId, category, errorMessage, {
          status_code: status,
          status_text: statusText,
          response: responseData,
          prompt_id: promptId,
          prompt_source: resolved.source,
          dispatcher_url: dispatcherUrl,
          workflow_id: workflowId,
          batch_workflow_id: batchWorkflowId,
          dispatch_attempts: attempts,
          retried_from: retriedFrom,
          timestamp: new Date().toISOString(),
        });
        if (promptId) {
          await client
            .schema('swat')
            .from('batch_workflows')
            .update({ run_id: promptId })
            .eq('id', batchWorkflowId);
        }
        results.push({
          workflowId,
          success: false,
          category,
          error: errorMessage,
          runId: promptId,
          attempts,
          retriedFrom,
        });
      } else {
        await client
          .schema('swat')
          .from('batch_workflows')
          .update({
            status: 'queued',
            run_id: promptId ?? null,
            error_details: {
              dispatch_attempts: attempts,
              ...(retriedFrom ? { retried_from: retriedFrom } : {}),
            },
          })
          .eq('id', batchWorkflowId);
        results.push({
          workflowId,
          success: true,
          category: 'none',
          runId: promptId,
          attempts,
          retriedFrom,
        });
      }
    } catch (err) {
      const message = (err as Error).message;
      await markFailed(client, batchWorkflowId, 'infra_error', message, {
        error_type: (err as Error).name,
        stack: (err as Error).stack,
        dispatcher_url: dispatcherUrl,
        workflow_id: workflowId,
        batch_workflow_id: batchWorkflowId,
        timestamp: new Date().toISOString(),
      });
      results.push({ workflowId, success: false, category: 'infra_error', error: message });
    }

    if (i < workflowIds.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  await recomputeBatchStatus(client, batchId).catch(() => undefined);
  return results;
}
