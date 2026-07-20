import 'server-only';
import { cookies } from 'next/headers';
import type { SupabaseClient } from '@supabase/supabase-js';
import { env } from '@/lib/config/env';

function projectRefFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname.split('.')[0] || null;
  } catch {
    return null;
  }
}

function filterAuthCookies(allCookies: { name: string; value: string }[], projectRef: string): string {
  const prefix = `sb-${projectRef}-auth-token`;
  return allCookies
    .filter((c) => c.name.startsWith(prefix))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

export interface DispatcherAuthResult {
  headers: Record<string, string>;
  teamId: string | null;
  ready: boolean;
  error?: string;
}

/**
 * Build auth headers for the Floyo global dispatcher.
 *
 * In split mode (dev login + prod data + prod dispatcher), the browser session
 * is usually on the auth Supabase project (dev), while dispatch.floyo.ai expects
 * prod Supabase cookies or a prod access token.
 */
export async function buildDispatcherAuth(
  workflowDb?: SupabaseClient,
  workflowId?: string
): Promise<DispatcherAuthResult> {
  if (!env.dispatcher.url) {
    return { headers: {}, teamId: null, ready: false, error: 'Dispatcher URL is not configured' };
  }

  const usesSplitData =
    !!env.supabase.dataUrl && env.supabase.dataUrl !== env.supabase.url;

  const authProjectRef =
    projectRefFromUrl(env.supabase.url) ||
    projectRefFromUrl(env.supabase.dataUrl) ||
    process.env.DISPATCHER_SUPABASE_PROJECT_ID ||
    null;

  const headers: Record<string, string> = {
    host: new URL(env.dispatcher.url).host,
  };

  const accessToken = process.env.DISPATCHER_AUTH_ACCESS_TOKEN?.trim();
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  } else if (authProjectRef) {
    const cookieStore = await cookies();
    const filtered = filterAuthCookies(cookieStore.getAll(), authProjectRef);
    if (filtered) headers.Cookie = filtered;
  }

  let teamId =
    process.env.DISPATCHER_TEAM_ID?.trim() ||
    (await cookies()).get('x-team-id')?.value ||
    null;

  if (!teamId && workflowDb && workflowId) {
    const { data } = await workflowDb
      .from('workflow_runs')
      .select('team_id')
      .eq('base_workflow_id', workflowId)
      .eq('status', 'done')
      .not('team_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    teamId = data?.team_id ?? null;
  }

  if (teamId) headers['x-team-id'] = teamId;

  const hasAuth = !!accessToken || !!headers.Cookie;
  if (!hasAuth) {
    return {
      headers,
      teamId,
      ready: false,
      error: usesSplitData
        ? 'Prod dispatcher auth missing. Log in to prod Floyo in this browser, or set DISPATCHER_AUTH_ACCESS_TOKEN and DISPATCHER_TEAM_ID in Swat_Prod/.env.'
        : 'Dispatcher auth missing. Sign in to Floyo in this browser first.',
    };
  }

  if (!teamId) {
    return {
      headers,
      teamId: null,
      ready: false,
      error:
        'Dispatcher team id missing. Set DISPATCHER_TEAM_ID in Swat_Prod/.env (your prod team UUID from floyo.ai).',
    };
  }

  return { headers, teamId, ready: true };
}
