'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client-browser';

type Status = 'loading' | 'unauthenticated' | 'forbidden' | 'authenticated';

function resolveLoginUrl(): string {
  const domain = process.env.NEXT_PUBLIC_MAIN_SITE_DOMAIN || 'https://floyo.ai';
  const base = domain.startsWith('http') ? domain : `https://${domain}`;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  return `${base.replace(/\/$/, '')}/a/login?returnTo=${encodeURIComponent(appUrl)}`;
}

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const supabase = useMemo(() => createClient(), []);
  const [status, setStatus] = useState<Status>('loading');

  const checkRole = useCallback(
    async (userId: string) => {
      const { data, error } = await supabase
        .from('users_metadata')
        .select('role')
        .eq('user_id', userId)
        .maybeSingle();

      if (error || !data || data.role !== 'admin') {
        setStatus('forbidden');
        return;
      }
      setStatus('authenticated');
    },
    [supabase]
  );

  const checkSession = useCallback(async () => {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session?.user) {
      setStatus('unauthenticated');
      return;
    }
    await checkRole(session.user.id);
  }, [supabase, checkRole]);

  useEffect(() => {
    let active = true;

    const init = async () => {
      const url = new URL(window.location.href);
      const code = url.searchParams.get('code');

      if (code) {
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        url.searchParams.delete('code');
        const clean = `${url.pathname}${url.search}${url.hash}`;
        window.history.replaceState({}, '', clean || '/');
        if (error) {
          console.error('SWAT OAuth code exchange failed:', error.message);
        }
      }

      if (!active) return;
      await checkSession();
    };

    init();

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!active) return;
      if (!session?.user) {
        setStatus('unauthenticated');
      } else {
        checkRole(session.user.id);
      }
    });

    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, [supabase, checkRole, checkSession]);

  useEffect(() => {
    if (status === 'unauthenticated' || status === 'forbidden') {
      const timer = setTimeout(() => {
        window.location.href = resolveLoginUrl();
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [status]);

  if (status === 'authenticated') {
    return <>{children}</>;
  }

  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center gap-3 bg-slate-950 text-slate-300">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-600 border-t-indigo-400" />
      <p className="text-sm">
        {status === 'loading' && 'Checking your session...'}
        {status === 'unauthenticated' && 'Redirecting you to sign in...'}
        {status === 'forbidden' && 'Admin access required. Redirecting...'}
      </p>
    </div>
  );
}
