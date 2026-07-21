import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { swatClient, workflowClient } from '@/lib/supabase/clients';
import { requireAdmin } from '@/lib/helpers/auth';
import { prepareQueueAuth } from '@/lib/helpers/dispatcher-auth';
import { getBatchById } from '@/lib/services/batch.service';
import { queueBatch } from '@/lib/services/queue.service';
import { REQUEUEABLE_STATUSES } from '@/lib/helpers/status';
import { errorResponse, successResponse } from '@/lib/helpers/response';

const queueSchema = z.object({
  workflowIds: z.array(z.string()).optional(),
  sequence: z.string().optional(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ batchId: string }> }
) {
  try {
    const auth = await requireAdmin();
    if (!auth.ok) return errorResponse(auth.error, auth.status);

    const { batchId } = await params;
    const body = await request.json().catch(() => ({}));
    const parsed = queueSchema.safeParse(body);
    if (!parsed.success) return errorResponse('Invalid request body', 400);

    const wf = workflowClient();
    const batch = await getBatchById(swatClient, batchId, wf);
    if (!batch) return errorResponse('Batch not found', 404);

    const workflowIds =
      parsed.data.workflowIds && parsed.data.workflowIds.length > 0
        ? parsed.data.workflowIds
        : batch.workflows
            .filter((w) => REQUEUEABLE_STATUSES.has(w.status))
            .map((w) => w.workflowId);

    if (workflowIds.length === 0) {
      return errorResponse(
        'No workflows to queue. Only pending, failed, blocked, or cancelled workflows can be re-run.',
        400
      );
    }

    const sequence = parsed.data.sequence ?? batch.sequence;
    const authSnapshot = await prepareQueueAuth(wf, workflowIds[0]);

    queueBatch(swatClient, batchId, workflowIds, sequence, wf, authSnapshot).catch((err) => {
      console.error(`[SWAT queue] Background queue failed for batch ${batchId}:`, err);
    });

    return successResponse({
      queued: true,
      count: workflowIds.length,
      batchId,
    });
  } catch (err) {
    return errorResponse((err as Error).message, 500);
  }
}
