import { NextResponse } from 'next/server';
import { ApiResponse } from '@/types';

export function successResponse<T>(
  data: T,
  message?: string,
  status: number = 200,
  options?: { noCache?: boolean }
): NextResponse<ApiResponse<T>> {
  const headers: Record<string, string> = {};
  if (options?.noCache) {
    headers['Cache-Control'] = 'no-store, no-cache, must-revalidate';
    headers.Pragma = 'no-cache';
  }
  return NextResponse.json({ success: true, data, message }, { status, headers });
}

export function errorResponse(error: string, status: number = 400): NextResponse<ApiResponse> {
  return NextResponse.json({ success: false, error }, { status });
}

export function unauthorizedResponse(message: string = 'Unauthorized'): NextResponse<ApiResponse> {
  return errorResponse(message, 401);
}

export function forbiddenResponse(message: string = 'Forbidden'): NextResponse<ApiResponse> {
  return errorResponse(message, 403);
}
