import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { swatClient } from '@/lib/supabase/clients';
import { requireAdmin } from '@/lib/helpers/auth';
import { removeWorkflowsFromBatch } from '@/lib/services/batch.service';
import { errorResponse, successResponse } from '@/lib/helpers/response';

const removeSchema = z.object({
  workflowIds: z.array(z.string()).min(1),
});

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ batchId: string }> }
) {
  try {
    const auth = await requireAdmin();
    if (!auth.ok) return errorResponse(auth.error, auth.status);

    const { batchId } = await params;
    const body = await request.json();
    const parsed = removeSchema.safeParse(body);
    if (!parsed.success) return errorResponse('Invalid request body', 400);

    const result = await removeWorkflowsFromBatch(
      swatClient,
      batchId,
      parsed.data.workflowIds
    );

    if (result.removed === 0) {
      return errorResponse(
        'No workflows removed. Only pending workflows can be removed from a batch.',
        400
      );
    }

    return successResponse(result);
  } catch (err) {
    return errorResponse((err as Error).message, 500);
  }
}
