import { type NextRequest } from 'next/server';
import { swatClient, workflowClient } from '@/lib/supabase/clients';
import { requireAdmin } from '@/lib/helpers/auth';
import { getWorkflowRunDetails } from '@/lib/services/workflow-run.service';
import { errorResponse, successResponse } from '@/lib/helpers/response';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ batchWorkflowId: string }> }
) {
  try {
    const auth = await requireAdmin();
    if (!auth.ok) return errorResponse(auth.error, auth.status);

    const { batchWorkflowId } = await params;
    const details = await getWorkflowRunDetails(
      swatClient,
      batchWorkflowId,
      workflowClient()
    );
    if (!details) return errorResponse('Run not found', 404);
    return successResponse(details);
  } catch (err) {
    return errorResponse((err as Error).message, 500);
  }
}
