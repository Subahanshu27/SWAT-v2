import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { swatClient, workflowClient } from '@/lib/supabase/clients';
import { requireAdmin } from '@/lib/helpers/auth';
import { prepareQueueAuth } from '@/lib/helpers/dispatcher-auth';
import { createBatch, listBatches } from '@/lib/services/batch.service';
import { queueBatch } from '@/lib/services/queue.service';
import { errorResponse, successResponse } from '@/lib/helpers/response';

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAdmin();
    if (!auth.ok) return errorResponse(auth.error, auth.status);

    const { searchParams } = new URL(request.url);
    const result = await listBatches(swatClient, {
      page: Number(searchParams.get('page')) || 1,
      pageSize: Number(searchParams.get('pageSize')) || 20,
    });
    return successResponse(result);
  } catch (err) {
    return errorResponse((err as Error).message, 500);
  }
}

const createBatchSchema = z.object({
  name: z.string().min(1),
  sequence: z.string().optional(),
  workflowIds: z.array(z.string().min(1)).min(1),
  runImmediately: z.boolean().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAdmin();
    if (!auth.ok) return errorResponse(auth.error, auth.status);

    const body = await request.json();
    const parsed = createBatchSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(parsed.error.issues.map((i) => i.message).join(', '), 400);
    }

    const wf = workflowClient();
    const batch = await createBatch(swatClient, {
      name: parsed.data.name,
      sequence: parsed.data.sequence,
      workflowIds: parsed.data.workflowIds,
      createdBy: auth.user.id,
    });

    let queuedImmediately = false;
    if (parsed.data.runImmediately) {
      const authSnapshot = await prepareQueueAuth(wf, parsed.data.workflowIds[0]);
      queueBatch(
        swatClient,
        batch.id,
        parsed.data.workflowIds,
        parsed.data.sequence,
        wf,
        authSnapshot
      ).catch((err) => {
        console.error(`[SWAT queue] Background queue failed for batch ${batch.id}:`, err);
      });
      queuedImmediately = true;
    }

    return successResponse({ batch, queued: queuedImmediately, count: parsed.data.workflowIds.length }, 'Batch created', 201);
  } catch (err) {
    return errorResponse((err as Error).message, 500);
  }
}
