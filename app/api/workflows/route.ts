import { type NextRequest } from 'next/server';
import { dataClient } from '@/lib/supabase/clients';
import { requireAdmin } from '@/lib/helpers/auth';
import { listWorkflows } from '@/lib/services/workflow.service';
import { errorResponse, successResponse } from '@/lib/helpers/response';

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAdmin();
    if (!auth.ok) return errorResponse(auth.error, auth.status);

    const { searchParams } = new URL(request.url);

    const result = await listWorkflows(dataClient, {
      page: Number(searchParams.get('page')) || 1,
      pageSize: Number(searchParams.get('pageSize')) || 25,
      search: searchParams.get('search') || undefined,
      verifiedOnly: searchParams.get('verifiedOnly') === 'true',
      includePrivate: searchParams.get('includePrivate') === 'true',
    });

    return successResponse(result);
  } catch (err) {
    return errorResponse((err as Error).message, 500);
  }
}
