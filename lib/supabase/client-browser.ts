// Browser-side Supabase client for use inside React client components.
import { createBrowserClient } from '@supabase/ssr';

const COOKIE_DOMAIN = (process.env.NEXT_PUBLIC_SUPABASE_COOKIE_DOMAIN as string) || '';

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookieOptions: {
        domain: COOKIE_DOMAIN || undefined,
        sameSite: 'lax',
        path: '/',
        secure: false,
      },
    }
  );
}
