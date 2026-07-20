import { type NextRequest } from 'next/server';
import { swatClient, workflowClient } from '@/lib/supabase/clients';
import { requireAdmin } from '@/lib/helpers/auth';
import { preflightSingleWorkflow } from '@/lib/services/preflight.service';
import { env } from '@/lib/config/env';
import { errorResponse, successResponse } from '@/lib/helpers/response';

function promptServiceBase(): string {
  return env.promptService.url.replace(/\/generate-prompt\/?$/, '');
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workflowId: string }> }
) {
  try {
    const auth = await requireAdmin();
    if (!auth.ok) return errorResponse(auth.error, auth.status);

    const { workflowId } = await params;
    const body = (await request.json().catch(() => ({}))) as { previousCategory?: string };
    const previousCategory = body.previousCategory || 'none';

    const base = promptServiceBase();
    if (base) {
      try {
        await fetch(`${base}/cache/clear-workflow`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workflow_id: workflowId }),
        });
      } catch (err) {
        console.warn(`[Recheck] Cache clear failed for ${workflowId}:`, err);
      }
    }

    const result = await preflightSingleWorkflow(swatClient, workflowId, workflowClient());

    return successResponse({
      workflow_id: workflowId,
      previous_category: previousCategory,
      new_category: result.category,
      changed: previousCategory !== result.category,
      message: result.reason || '',
      queueable: result.queueable,
    });
  } catch (err) {
    return errorResponse((err as Error).message, 500);
  }
}
