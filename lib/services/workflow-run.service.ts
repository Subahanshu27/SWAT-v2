import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ErrorCategory, WorkflowStatus } from '@/types';
import { SUCCESS_STATUSES, classifyError } from '@/lib/helpers/status';

export interface WorkflowRunDetails {
  batchWorkflowId: string;
  workflowId: string;
  name: string;
  status: WorkflowStatus;
  runId?: string;
  startedAt?: string;
  completedAt?: string;
  durationSeconds?: number;
  timeInQueueSeconds?: number;
  executionTimeSeconds?: number;
  goldenImageHash?: string;
  actualImageHash?: string;
  goldenRunId?: string;
  goldenCreatedAt?: string;
  errorCategory: ErrorCategory;
  errorMessage?: string;
  errorDetails?: unknown;
}

/**
 * Fetch detailed info for a single batch workflow (by batch_workflows.id),
 * including a "golden" reference from the most recent previous success.
 */
export async function getWorkflowRunDetails(
  client: SupabaseClient,
  batchWorkflowId: string,
  workflowDb: SupabaseClient = client
): Promise<WorkflowRunDetails | null> {
  const { data: row, error } = await client
    .schema('swat')
    .from('batch_workflows')
    .select(
      'id, workflow_id, status, run_id, started_at, completed_at, duration, time_in_queue, execution_time, golden_image_hash, actual_image_hash, error_details, created_at'
    )
    .eq('id', batchWorkflowId)
    .maybeSingle();

  if (error) throw error;
  if (!row) return null;

  const { data: workflow } = await workflowDb
    .from('workflows')
    .select('id, name')
    .eq('id', row.workflow_id)
    .maybeSingle();

  // Golden reference: most recent previous successful run of the same workflow.
  const { data: golden } = await client
    .schema('swat')
    .from('batch_workflows')
    .select('run_id, created_at, actual_image_hash')
    .eq('workflow_id', row.workflow_id)
    .in('status', Array.from(SUCCESS_STATUSES))
    .not('run_id', 'is', null)
    .lt('created_at', row.created_at || new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const { category, message } = classifyError(row.status, row.error_details);

  return {
    batchWorkflowId: row.id,
    workflowId: row.workflow_id,
    name: workflow?.name || 'Untitled workflow',
    status: row.status,
    runId: row.run_id || undefined,
    startedAt: row.started_at || undefined,
    completedAt: row.completed_at || undefined,
    durationSeconds: row.duration ?? undefined,
    timeInQueueSeconds: row.time_in_queue ?? undefined,
    executionTimeSeconds: row.execution_time ?? undefined,
    goldenImageHash: row.golden_image_hash || undefined,
    actualImageHash: row.actual_image_hash || undefined,
    goldenRunId: golden?.run_id || undefined,
    goldenCreatedAt: golden?.created_at || undefined,
    errorCategory: category,
    errorMessage: message,
    errorDetails: row.error_details ?? undefined,
  };
}
