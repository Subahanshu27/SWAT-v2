import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { swatClient } from '@/lib/supabase/clients';
import { recomputeBatchStatus } from '@/lib/services/batch.service';
import { isTerminal, mapRunStatusToWorkflowStatus } from '@/lib/helpers/status';
import { errorResponse, successResponse } from '@/lib/helpers/response';

/**
 * Status callback for the dispatcher. Updates a single batch_workflow by its
 * run_id (the dispatcher's prompt_id) and reconciles the parent batch.
 *
 * Uses the service-role client so the dispatcher can call without a user
 * session. Keep this endpoint protected at the network layer in production.
 */
const statusSchema = z.object({
  runId: z.string().min(1).optional(),
  prompt_id: z.string().min(1).optional(),
  status: z.string().min(1),
  finished_at: z.string().optional(),
  error: z.unknown().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    const parsed = statusSchema.safeParse(body);
    if (!parsed.success) return errorResponse('Invalid request body', 400);

    const runId = parsed.data.runId || parsed.data.prompt_id;
    if (!runId) return errorResponse('runId or prompt_id is required', 400);

    const normalized = mapRunStatusToWorkflowStatus(parsed.data.status);
    if (!normalized) return errorResponse(`Unsupported status: ${parsed.data.status}`, 400);

    const { data: row, error: findError } = await swatClient
      .schema('swat')
      .from('batch_workflows')
      .select('id, batch_id')
      .eq('run_id', runId)
      .maybeSingle();

    if (findError) throw findError;
    if (!row) return errorResponse('No workflow found for run id', 404);

    const update: Record<string, unknown> = { status: normalized };
    if (isTerminal(normalized)) {
      update.completed_at = parsed.data.finished_at || new Date().toISOString();
    }
    if (parsed.data.error) {
      update.error_details = parsed.data.error;
    }

    const { error: updateError } = await swatClient
      .schema('swat')
      .from('batch_workflows')
      .update(update)
      .eq('id', row.id);
    if (updateError) throw updateError;

    await recomputeBatchStatus(swatClient, row.batch_id).catch(() => undefined);

    return successResponse({ updated: true, status: normalized });
  } catch (err) {
    return errorResponse((err as Error).message, 500);
  }
}
