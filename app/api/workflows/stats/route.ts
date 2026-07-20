import { type NextRequest } from 'next/server';
import { dataClient } from '@/lib/supabase/clients';
import { requireAdmin } from '@/lib/helpers/auth';
import { getWorkflowCatalogStats } from '@/lib/services/workflow.service';
import { errorResponse, successResponse } from '@/lib/helpers/response';

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAdmin();
    if (!auth.ok) return errorResponse(auth.error, auth.status);

    const { searchParams } = new URL(request.url);
    const includePrivate = searchParams.get('includePrivate') === 'true';

    const stats = await getWorkflowCatalogStats(dataClient, { includePrivate });
    return successResponse(stats);
  } catch (err) {
    return errorResponse((err as Error).message, 500);
  }
}
