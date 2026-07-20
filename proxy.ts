import { NextResponse, type NextRequest } from 'next/server';
import { updateSession } from './utils/supabase/middleware';

export async function proxy(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl;

  if (searchParams.has('code') && !pathname.startsWith('/auth/callback')) {
    const url = request.nextUrl.clone();
    url.pathname = '/auth/callback';
    return NextResponse.redirect(url);
  }

  return await updateSession(request);
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
