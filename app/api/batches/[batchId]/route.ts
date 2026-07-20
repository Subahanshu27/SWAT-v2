import { type NextRequest } from 'next/server';
import { swatClient, workflowClient } from '@/lib/supabase/clients';
import { requireAdmin } from '@/lib/helpers/auth';
import { getBatchById, reconcileBatchWorkflowRuns } from '@/lib/services/batch.service';
import { ACTIVE_STATUSES } from '@/lib/helpers/status';
import { errorResponse, successResponse } from '@/lib/helpers/response';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ batchId: string }> }
) {
  try {
    const auth = await requireAdmin();
    if (!auth.ok) return errorResponse(auth.error, auth.status);

    const { batchId } = await params;
    const wf = workflowClient();
    let batch = await getBatchById(swatClient, batchId, wf);
    if (!batch) return errorResponse('Batch not found', 404);

    const isActive =
      ACTIVE_STATUSES.has(batch.status) ||
      batch.workflows.some((workflow) => ACTIVE_STATUSES.has(workflow.status));

    // Reconcile active batches against workflow_runs (no-op when no run_ids yet).
    if (isActive) {
      const { updated } = await reconcileBatchWorkflowRuns(swatClient, batchId, wf);
      if (updated > 0) {
        batch = await getBatchById(swatClient, batchId, wf);
        if (!batch) return errorResponse('Batch not found', 404);
      }
    }

    return successResponse(batch);
  } catch (err) {
    return errorResponse((err as Error).message, 500);
  }
}
