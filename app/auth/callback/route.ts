import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const returnTo =
    searchParams.get('returnTo') ||
    process.env.NEXT_PUBLIC_APP_URL ||
    'http://localhost:3000';

  if (!code) {
    return NextResponse.redirect(returnTo.startsWith('http') ? returnTo : `${origin}${returnTo}`);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    console.error('SWAT auth callback failed:', error.message);
    return NextResponse.redirect(`${origin}/?auth_error=1`);
  }

  const target = returnTo.startsWith('http') ? returnTo : `${origin}${returnTo}`;
  return NextResponse.redirect(target);
}
