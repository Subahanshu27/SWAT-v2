import { getCurrentUser } from '@/lib/helpers/auth';
import { errorResponse, successResponse } from '@/lib/helpers/response';

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) return errorResponse('Not authenticated', 401);
    return successResponse(user);
  } catch (err) {
    return errorResponse((err as Error).message, 500);
  }
}
