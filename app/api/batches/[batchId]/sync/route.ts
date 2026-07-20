import { type NextRequest } from 'next/server';
import { swatClient, workflowClient } from '@/lib/supabase/clients';
import { requireAdmin } from '@/lib/helpers/auth';
import {
  getBatchById,
  recomputeBatchStatus,
  reconcileBatchWorkflowRuns,
} from '@/lib/services/batch.service';
import { errorResponse, successResponse } from '@/lib/helpers/response';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ batchId: string }> }
) {
  try {
    const auth = await requireAdmin();
    if (!auth.ok) return errorResponse(auth.error, auth.status);

    const { batchId } = await params;
    const wf = workflowClient();
    await reconcileBatchWorkflowRuns(swatClient, batchId, wf);
    await recomputeBatchStatus(swatClient, batchId);
    const batch = await getBatchById(swatClient, batchId, wf);
    if (!batch) return errorResponse('Batch not found', 404);
    return successResponse(batch);
  } catch (err) {
    return errorResponse((err as Error).message, 500);
  }
}
