import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  BatchDetail,
  BatchStatus,
  BatchSummary,
  BatchWorkflow,
  Paginated,
  WorkflowStatus,
} from '@/types';
import { chunkArray } from '@/lib/helpers/chunk';
import {
  ACTIVE_STATUSES,
  FAILURE_STATUSES,
  SUCCESS_STATUSES,
  TERMINAL_STATUSES,
  classifyError,
  deriveBatchStatus,
  mapRunStatusToWorkflowStatus,
  toBatchesTableStatus,
} from '@/lib/helpers/status';

interface BatchRow {
  id: string;
  name: string;
  status: BatchStatus;
  sequence: string | null;
  started_at: string | null;
  completed_at: string | null;
  duration: number | null;
  progress: number | null;
  total_workflows: number | null;
  completed_workflows: number | null;
  failed_workflows: number | null;
  created_at: string | null;
}

interface BatchWorkflowRow {
  id: string;
  batch_id: string;
  workflow_id: string;
  status: WorkflowStatus;
  position: number | null;
  priority: number | null;
  run_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  duration: number | null;
  time_in_queue: number | null;
  execution_time: number | null;
  golden_image_hash: string | null;
  actual_image_hash: string | null;
  error_details: unknown;
}

interface WorkflowRunRow {
  id: string;
  status: string | null;
  started_at: string | null;
  finished_at: string | null;
  error_details: unknown;
  public_id: string | null;
}

const BATCH_COLUMNS =
  'id, name, status, sequence, started_at, completed_at, duration, progress, total_workflows, completed_workflows, failed_workflows, created_at';

/** List view — omit heavy error_details JSON (loaded on demand in run details). */
const BATCH_WORKFLOW_LIST_COLUMNS =
  'id, batch_id, workflow_id, status, position, priority, run_id, started_at, completed_at, duration, time_in_queue, execution_time, golden_image_hash, actual_image_hash';

const BATCH_WORKFLOW_COLUMNS = `${BATCH_WORKFLOW_LIST_COLUMNS}, error_details`;

const IN_QUERY_CHUNK = 100;

/** Lightweight lookup: workflow ids for a batch (avoids loading full batch detail). */
export async function getBatchWorkflowIds(
  client: SupabaseClient,
  batchId: string
): Promise<string[] | null> {
  const { data: batch, error: batchError } = await client
    .schema('swat')
    .from('batches')
    .select('id')
    .eq('id', batchId)
    .maybeSingle();
  if (batchError) throw batchError;
  if (!batch) return null;

  const { data, error } = await client
    .schema('swat')
    .from('batch_workflows')
    .select('workflow_id')
    .eq('batch_id', batchId)
    .order('position', { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row: { workflow_id: string }) => row.workflow_id);
}

async function fetchWorkflowMetaByIds(
  workflowDb: SupabaseClient,
  workflowIds: string[]
): Promise<Map<string, { name: string; verified: boolean }>> {
  const nameById = new Map<string, { name: string; verified: boolean }>();
  for (const chunk of chunkArray(workflowIds, IN_QUERY_CHUNK)) {
    const { data, error } = await workflowDb
      .from('workflows')
      .select('id, name, verified_to_run')
      .in('id', chunk);
    if (error) throw error;
    (data ?? []).forEach((w: { id: string; name: string | null; verified_to_run: boolean | null }) => {
      nameById.set(w.id, { name: w.name || 'Untitled workflow', verified: !!w.verified_to_run });
    });
  }
  return nameById;
}

async function fetchWorkflowRunsByIds(
  workflowDb: SupabaseClient,
  runIds: string[]
): Promise<Map<string, WorkflowRunRow>> {
  const runById = new Map<string, WorkflowRunRow>();
  for (const chunk of chunkArray(runIds, IN_QUERY_CHUNK)) {
    const { data, error } = await workflowDb
      .from('workflow_runs')
      .select('id, status, started_at, finished_at, error_details, public_id')
      .in('id', chunk);
    if (error) throw error;
    ((data as WorkflowRunRow[] | null) ?? []).forEach((run) => runById.set(run.id, run));
  }
  return runById;
}

function mapBatchSummary(row: BatchRow): BatchSummary {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    sequence: row.sequence || undefined,
    startedAt: row.started_at || undefined,
    completedAt: row.completed_at || undefined,
    durationSeconds: row.duration ?? undefined,
    progress: row.progress ?? 0,
    totalWorkflows: row.total_workflows ?? 0,
    completedWorkflows: row.completed_workflows ?? 0,
    failedWorkflows: row.failed_workflows ?? 0,
    createdAt: row.created_at || undefined,
  };
}

function mapBatchWorkflow(row: BatchWorkflowRow, name: string): BatchWorkflow {
  const { category, message } = classifyError(row.status, row.error_details);
  return {
    id: row.id,
    batchId: row.batch_id,
    workflowId: row.workflow_id,
    name,
    verified: false,
    status: row.status,
    position: row.position ?? undefined,
    priority: row.priority ?? undefined,
    runId: row.run_id || undefined,
    startedAt: row.started_at || undefined,
    completedAt: row.completed_at || undefined,
    durationSeconds: row.duration ?? undefined,
    timeInQueueSeconds: row.time_in_queue ?? undefined,
    executionTimeSeconds: row.execution_time ?? undefined,
    goldenImageHash: row.golden_image_hash || undefined,
    actualImageHash: row.actual_image_hash || undefined,
    errorCategory: category,
    errorMessage: message,
    errorDetails: row.error_details ?? undefined,
  };
}

function secondsBetween(start?: string | null, end?: string | null): number | undefined {
  if (!start || !end) return undefined;
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return undefined;
  return Math.max(0, Math.round((endMs - startMs) / 1000));
}

function buildRunErrorDetails(run: WorkflowRunRow): Record<string, unknown> | undefined {
  if (!run.error_details) return undefined;
  return {
    response: run.error_details,
    prompt_id: run.id,
    public_id: run.public_id ?? undefined,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Paginated batch history. Reads ONLY the batches table (no workflows), so the
 * history list stays fast regardless of how many workflows each batch has.
 */
export async function listBatches(
  client: SupabaseClient,
  params: { page?: number; pageSize?: number } = {}
): Promise<Paginated<BatchSummary>> {
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 20));
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const { data, error, count } = await client
    .schema('swat')
    .from('batches')
    .select(BATCH_COLUMNS, { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to);

  if (error) throw error;

  const items = (data as BatchRow[] | null)?.map(mapBatchSummary) ?? [];
  const total = count ?? items.length;
  return { items, total, page, pageSize, hasMore: from + items.length < total };
}

/**
 * Efficient single-batch fetch.
 *
 * KEY FIX vs old SWAT: only the workflows belonging to THIS batch are loaded
 * (filtered by batch_id), then their names are resolved in a single bulk query.
 * The old code loaded every workflow in the database to build this view.
 */
export async function getBatchById(
  client: SupabaseClient,
  batchId: string,
  workflowDb: SupabaseClient = client
): Promise<BatchDetail | null> {
  const { data: batchRow, error: batchError } = await client
    .schema('swat')
    .from('batches')
    .select(BATCH_COLUMNS)
    .eq('id', batchId)
    .maybeSingle();

  if (batchError) throw batchError;
  if (!batchRow) return null;

  const { data: workflowRows, error: workflowError } = await client
    .schema('swat')
    .from('batch_workflows')
    .select(BATCH_WORKFLOW_LIST_COLUMNS)
    .eq('batch_id', batchId)
    .order('position', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: true });

  if (workflowError) throw workflowError;

  const rows = (workflowRows as BatchWorkflowRow[] | null) ?? [];
  const workflowIds = Array.from(new Set(rows.map((r) => r.workflow_id)));

  const nameById =
    workflowIds.length > 0 ? await fetchWorkflowMetaByIds(workflowDb, workflowIds) : new Map();

  const workflows = rows.map((row) => {
    const meta = nameById.get(row.workflow_id);
    const mapped = mapBatchWorkflow(row, meta?.name || 'Untitled workflow');
    mapped.verified = meta?.verified ?? false;
    return mapped;
  });

  return { ...mapBatchSummary(batchRow as BatchRow), workflows };
}

/**
 * Create a batch and its batch_workflows rows.
 */
export async function createBatch(
  client: SupabaseClient,
  params: { name: string; sequence?: string; workflowIds: string[]; createdBy?: string }
): Promise<BatchSummary> {
  const { data: batch, error: batchError } = await client
    .schema('swat')
    .from('batches')
    .insert({
      name: params.name,
      status: 'pending',
      sequence: params.sequence ?? null,
      total_workflows: params.workflowIds.length,
      created_by: params.createdBy ?? null,
    })
    .select(BATCH_COLUMNS)
    .single();

  if (batchError) throw batchError;

  if (params.workflowIds.length > 0) {
    const rows = params.workflowIds.map((workflowId, index) => ({
      batch_id: batch.id,
      workflow_id: workflowId,
      status: 'pending' as WorkflowStatus,
      position: index,
      priority: 0,
    }));
    for (const chunk of chunkArray(rows, IN_QUERY_CHUNK)) {
      const { error: insertError } = await client.schema('swat').from('batch_workflows').insert(chunk);
      if (insertError) throw insertError;
    }
  }

  return mapBatchSummary(batch as BatchRow);
}

/**
 * Recompute and persist a batch's aggregate status from its workflows.
 * Used as a fallback/reconcile path even when DB triggers exist.
 */
export async function recomputeBatchStatus(
  client: SupabaseClient,
  batchId: string
): Promise<void> {
  const { data, error } = await client
    .schema('swat')
    .from('batch_workflows')
    .select('status, started_at, completed_at')
    .eq('batch_id', batchId);

  if (error) throw error;
  const rows = (data as { status: WorkflowStatus; started_at: string | null; completed_at: string | null }[]) || [];
  if (rows.length === 0) return;

  const statuses = rows.map((r) => r.status);
  const newStatus = deriveBatchStatus(statuses);
  const total = rows.length;
  const successCount = rows.filter((r) => SUCCESS_STATUSES.has(r.status)).length;
  const failedCount = rows.filter((r) => FAILURE_STATUSES.has(r.status)).length;
  const terminalCount = rows.filter((r) => TERMINAL_STATUSES.has(r.status)).length;
  const isTerminalBatch = !rows.some((r) => ACTIVE_STATUSES.has(r.status));

  const startTimes = rows
    .map((r) => (r.started_at ? new Date(r.started_at).getTime() : null))
    .filter((t): t is number => t !== null)
    .sort((a, b) => a - b);
  const endTimes = rows
    .map((r) => (r.completed_at ? new Date(r.completed_at).getTime() : null))
    .filter((t): t is number => t !== null)
    .sort((a, b) => b - a);

  const update: Record<string, unknown> = {
    status: toBatchesTableStatus(newStatus),
    total_workflows: total,
    completed_workflows: successCount,
    failed_workflows: failedCount,
    progress: Math.round((terminalCount / total) * 100),
    updated_at: new Date().toISOString(),
  };

  if (isTerminalBatch && endTimes.length > 0) {
    const completedAt = endTimes[0];
    update.completed_at = new Date(completedAt).toISOString();
    if (startTimes.length > 0) {
      update.duration = Math.max(0, Math.round((completedAt - startTimes[0]) / 1000));
    }
  }

  const { error: updateError } = await client
    .schema('swat')
    .from('batches')
    .update(update)
    .eq('id', batchId);

  if (updateError) throw updateError;
}

/**
 * Reconcile active SWAT rows with the main app's workflow_runs table.
 *
 * Local SWAT2 cannot rely on dispatcher callbacks because the dispatcher cannot
 * call back into localhost. This reads the dispatcher/source-of-truth run rows
 * by run_id and persists any status changes into swat.batch_workflows.
 */
export async function reconcileBatchWorkflowRuns(
  client: SupabaseClient,
  batchId: string,
  workflowDb: SupabaseClient = client
): Promise<{ checked: number; updated: number }> {
  const result = await reconcileActiveWorkflowRuns(client, batchId, workflowDb);
  if (result.updated > 0) {
    await recomputeBatchStatus(client, batchId);
  }
  return result;
}

export async function reconcileAllActiveWorkflowRuns(
  client: SupabaseClient,
  workflowDb: SupabaseClient = client
): Promise<{ checked: number; updated: number; batchesUpdated: number }> {
  return reconcileActiveWorkflowRuns(client, undefined, workflowDb);
}

async function reconcileActiveWorkflowRuns(
  client: SupabaseClient,
  batchId?: string,
  workflowDb: SupabaseClient = client
): Promise<{ checked: number; updated: number; batchesUpdated: number }> {
  let query = client
    .schema('swat')
    .from('batch_workflows')
    .select('id, batch_id, run_id, status')
    .not('run_id', 'is', null)
    .in('status', Array.from(ACTIVE_STATUSES));

  if (batchId) {
    query = query.eq('batch_id', batchId);
  }

  const { data: activeRows, error: activeError } = await query;

  if (activeError) throw activeError;

  const rows =
    (activeRows as { id: string; batch_id?: string; run_id: string | null; status: WorkflowStatus }[] | null) ?? [];
  const runIds = rows.map((row) => row.run_id).filter((runId): runId is string => !!runId);
  if (runIds.length === 0) return { checked: 0, updated: 0, batchesUpdated: 0 };

  const runById = await fetchWorkflowRunsByIds(workflowDb, runIds);

  let updated = 0;
  const changedBatchIds = new Set<string>();
  for (const row of rows) {
    if (!row.run_id) continue;
    const run = runById.get(row.run_id);
    if (!run?.status) continue;

    const normalized = mapRunStatusToWorkflowStatus(run.status);
    if (!normalized || normalized === row.status) continue;

    const update: Record<string, unknown> = {
      status: normalized,
      started_at: run.started_at,
    };

    if (TERMINAL_STATUSES.has(normalized)) {
      update.completed_at = run.finished_at || new Date().toISOString();
      const duration = secondsBetween(run.started_at, run.finished_at);
      if (duration !== undefined) {
        update.duration = duration;
        update.execution_time = duration;
      }
    }

    const errorDetails = buildRunErrorDetails(run);
    if (errorDetails) {
      update.error_details = errorDetails;
    } else if (SUCCESS_STATUSES.has(normalized)) {
      update.error_details = null;
    }

    const { error: updateError } = await client
      .schema('swat')
      .from('batch_workflows')
      .update(update)
      .eq('id', row.id);

    if (updateError) throw updateError;
    updated += 1;
    if (row.batch_id) changedBatchIds.add(row.batch_id);
  }

  for (const changedBatchId of changedBatchIds) {
    await recomputeBatchStatus(client, changedBatchId);
  }

  return { checked: runIds.length, updated, batchesUpdated: changedBatchIds.size };
}

/**
 * Permanently remove pending workflows from a batch (before or between runs).
 * Only rows still in `pending` are deleted; others are left untouched.
 */
export async function removeWorkflowsFromBatch(
  client: SupabaseClient,
  batchId: string,
  workflowIds: string[]
): Promise<{ removed: number; notRemovable: number }> {
  if (workflowIds.length === 0) return { removed: 0, notRemovable: 0 };

  const { data: rows, error } = await client
    .schema('swat')
    .from('batch_workflows')
    .select('id, workflow_id, status')
    .eq('batch_id', batchId)
    .in('workflow_id', workflowIds);

  if (error) throw error;

  const pendingIds = (rows || [])
    .filter((row) => row.status === 'pending')
    .map((row) => row.id);
  const notRemovable = workflowIds.length - pendingIds.length;

  if (pendingIds.length === 0) return { removed: 0, notRemovable };

  const { error: deleteError } = await client
    .schema('swat')
    .from('batch_workflows')
    .delete()
    .in('id', pendingIds);

  if (deleteError) throw deleteError;

  const { count, error: countError } = await client
    .schema('swat')
    .from('batch_workflows')
    .select('*', { count: 'exact', head: true })
    .eq('batch_id', batchId);

  if (countError) throw countError;

  if ((count ?? 0) === 0) {
    await client
      .schema('swat')
      .from('batches')
      .update({
        status: 'pending',
        total_workflows: 0,
        completed_workflows: 0,
        failed_workflows: 0,
        progress: 0,
        updated_at: new Date().toISOString(),
      })
      .eq('id', batchId);
  } else {
    await recomputeBatchStatus(client, batchId);
  }

  return { removed: pendingIds.length, notRemovable };
}
