import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

const COOKIE_DOMAIN = (process.env.SUPABASE_COOKIE_DOMAIN as string) || '';

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => {
            const cookieOptions = {
              ...options,
              ...(COOKIE_DOMAIN === 'localhost' ? { secure: false } : {}),
            };
            if (COOKIE_DOMAIN) {
              supabaseResponse.cookies.set(name, value, { ...cookieOptions, domain: COOKIE_DOMAIN });
            } else {
              supabaseResponse.cookies.set(name, value, cookieOptions);
            }
          });
        },
      },
    }
  );

  // IMPORTANT: keep getUser() immediately after client creation. Adding logic
  // in between can cause hard-to-debug random logouts.
  await supabase.auth.getUser();

  return supabaseResponse;
}
