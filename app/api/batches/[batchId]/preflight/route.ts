import { randomUUID } from 'node:crypto';
import { type NextRequest } from 'next/server';
import { swatClient, workflowClient } from '@/lib/supabase/clients';
import { requireAdmin } from '@/lib/helpers/auth';
import { coalescePreflight } from '@/lib/helpers/preflight-lock';
import { getBatchWorkflowIds } from '@/lib/services/batch.service';
import { preflightWorkflows } from '@/lib/services/preflight.service';
import { errorResponse, successResponse } from '@/lib/helpers/response';

/** Large batches can take several minutes (600 × prompt-service). */
export const maxDuration = 600;

async function runPreflight(batchId: string, requestId: string) {
  const wf = workflowClient();
  const workflowIds = await getBatchWorkflowIds(swatClient, batchId);
  if (!workflowIds) return errorResponse('Batch not found', 404);
  if (workflowIds.length === 0) {
    return successResponse({ total: 0, queueable: 0, blocked: 0, items: [] }, undefined, 200, {
      noCache: true,
    });
  }

  const result = await preflightWorkflows(swatClient, workflowIds, wf, {
    batchId,
    requestId,
  });
  console.log(
    `[SWAT preflight] req=${requestId} HTTP response — ${result.queueable} queueable, ${result.blocked} blocked`
  );
  return successResponse(result, undefined, 200, { noCache: true });
}

async function handlePreflight(batchId: string) {
  const requestId = randomUUID().slice(0, 8);
  return coalescePreflight(batchId, () => runPreflight(batchId, requestId));
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ batchId: string }> }
) {
  try {
    const auth = await requireAdmin();
    if (!auth.ok) return errorResponse(auth.error, auth.status);

    const { batchId } = await params;
    return await handlePreflight(batchId);
  } catch (err) {
    return errorResponse((err as Error).message, 500);
  }
}

/** POST avoids browser/proxy caching of long-running preflight GET responses. */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ batchId: string }> }
) {
  try {
    const auth = await requireAdmin();
    if (!auth.ok) return errorResponse(auth.error, auth.status);

    const { batchId } = await params;
    return await handlePreflight(batchId);
  } catch (err) {
    return errorResponse((err as Error).message, 500);
  }
}
