// Server-side Supabase client (App Router). Reads/writes auth cookies.
import 'server-only';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

const COOKIE_DOMAIN = (process.env.SUPABASE_COOKIE_DOMAIN as string) || '';

export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              const cookieOptions = {
                ...options,
                ...(COOKIE_DOMAIN === 'localhost' ? { secure: false } : {}),
              };
              if (COOKIE_DOMAIN) {
                cookieStore.set(name, value, { ...cookieOptions, domain: COOKIE_DOMAIN });
              } else {
                cookieStore.set(name, value, cookieOptions);
              }
            });
          } catch {
            // Called from a Server Component; ignored because middleware
            // refreshes the session.
          }
        },
      },
    }
  );
}
