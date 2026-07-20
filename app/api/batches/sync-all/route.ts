import { type NextRequest } from 'next/server';
import { swatClient, workflowClient } from '@/lib/supabase/clients';
import { requireAdmin } from '@/lib/helpers/auth';
import { reconcileAllActiveWorkflowRuns } from '@/lib/services/batch.service';
import { errorResponse, successResponse } from '@/lib/helpers/response';

export async function POST(_request: NextRequest) {
  try {
    const auth = await requireAdmin();
    if (!auth.ok) return errorResponse(auth.error, auth.status);

    const result = await reconcileAllActiveWorkflowRuns(swatClient, workflowClient());
    return successResponse(result);
  } catch (err) {
    return errorResponse((err as Error).message, 500);
  }
}

export async function GET(request: NextRequest) {
  return POST(request);
}
