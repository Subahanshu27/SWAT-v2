import 'server-only';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import type { SupabaseClient } from '@supabase/supabase-js';
import { env } from '@/lib/config/env';
import { createClient } from '@/lib/supabase/server';

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

/** Captured at queue start; refreshed in long background runs via refresh_token. */
export interface QueueAuthSnapshot {
  accessToken: string | null;
  refreshToken: string | null;
  expiresAtMs: number | null;
  teamId: string | null;
  /** When set, bearer comes from env (no refresh). */
  envAccessToken: string | null;
}

const REFRESH_BUFFER_MS = 5 * 60 * 1000;

async function resolveTeamId(
  supabaseClient?: SupabaseClient,
  workflowDb?: SupabaseClient,
  workflowId?: string
): Promise<string | null> {
  const cookieStore = await cookies();
  let teamId =
    process.env.DISPATCHER_TEAM_ID?.trim() ||
    cookieStore.get('x-team-id')?.value ||
    null;

  if (!teamId && supabaseClient) {
    try {
      const {
        data: { user },
      } = await supabaseClient.auth.getUser();
      if (user) {
        const { data: userMetadata } = await supabaseClient
          .from('users_metadata')
          .select('selected_team_id')
          .eq('user_id', user.id)
          .maybeSingle();
        teamId = userMetadata?.selected_team_id ?? null;
        if (teamId) {
          try {
            cookieStore.set('x-team-id', teamId, {
              httpOnly: true,
              secure: env.isProduction,
              sameSite: 'lax',
              path: '/',
              maxAge: 60 * 60 * 24 * 7,
            });
          } catch {
            // Server Component context — cookie may be set on a later route handler call.
          }
        }
      }
    } catch {
      // Fall through to workflow_runs lookup below.
    }
  }

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

  return teamId;
}

function authHeadersFromSnapshot(snapshot: QueueAuthSnapshot, teamId: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    host: new URL(env.dispatcher.url).host,
  };

  const token = snapshot.envAccessToken || snapshot.accessToken;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  if (teamId) headers['x-team-id'] = teamId;

  return headers;
}

/**
 * Capture dispatcher auth at the start of a queue request (while cookies are available).
 * Call before returning an async queue response.
 */
export async function prepareQueueAuth(
  workflowDb?: SupabaseClient,
  workflowId?: string
): Promise<QueueAuthSnapshot> {
  const envAccessToken = process.env.DISPATCHER_AUTH_ACCESS_TOKEN?.trim() || null;

  let accessToken: string | null = envAccessToken;
  let refreshToken: string | null = null;
  let expiresAtMs: number | null = null;

  if (!envAccessToken) {
    const authClient = await createClient();
    const {
      data: { session },
    } = await authClient.auth.getSession();
    if (session) {
      accessToken = session.access_token;
      refreshToken = session.refresh_token ?? null;
      expiresAtMs = session.expires_at ? session.expires_at * 1000 : null;
    }
  }

  const authClient = await createClient();
  const teamId = await resolveTeamId(authClient, workflowDb, workflowId);

  return { accessToken, refreshToken, expiresAtMs, teamId, envAccessToken };
}

/** Refresh access token when near expiry (long batch queue runs). */
export async function ensureFreshQueueAuth(snapshot: QueueAuthSnapshot): Promise<QueueAuthSnapshot> {
  if (snapshot.envAccessToken || !snapshot.refreshToken) {
    return snapshot;
  }

  const expiresSoon =
    !snapshot.accessToken ||
    !snapshot.expiresAtMs ||
    snapshot.expiresAtMs - Date.now() < REFRESH_BUFFER_MS;

  if (!expiresSoon) return snapshot;

  try {
    const supabase = createSupabaseClient(env.supabase.url, env.supabase.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await supabase.auth.refreshSession({
      refresh_token: snapshot.refreshToken,
    });
    if (error || !data.session) {
      console.warn('[SWAT auth] refreshSession failed:', error?.message || 'no session');
      return snapshot;
    }
    return {
      ...snapshot,
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token ?? snapshot.refreshToken,
      expiresAtMs: data.session.expires_at ? data.session.expires_at * 1000 : null,
    };
  } catch (err) {
    console.warn('[SWAT auth] refreshSession error:', (err as Error).message);
    return snapshot;
  }
}

export async function buildDispatcherAuthFromSnapshot(
  snapshot: QueueAuthSnapshot,
  workflowDb?: SupabaseClient,
  workflowId?: string
): Promise<DispatcherAuthResult> {
  if (!env.dispatcher.url) {
    return { headers: {}, teamId: null, ready: false, error: 'Dispatcher URL is not configured' };
  }

  const usesSplitData =
    !!env.supabase.dataUrl && env.supabase.dataUrl !== env.supabase.url;

  let teamId = snapshot.teamId;
  if (!teamId) {
    teamId = await resolveTeamId(undefined, workflowDb, workflowId);
  }

  const headers = authHeadersFromSnapshot(snapshot, teamId);
  const hasAuth = !!(snapshot.envAccessToken || snapshot.accessToken);

  if (!hasAuth) {
    return {
      headers,
      teamId,
      ready: false,
      error: usesSplitData
        ? 'Prod dispatcher auth missing. Log in to prod Floyo in this browser, or set DISPATCHER_AUTH_ACCESS_TOKEN and DISPATCHER_TEAM_ID in .env.'
        : 'Dispatcher auth missing. Sign in to Floyo in this browser first.',
    };
  }

  if (!teamId) {
    return {
      headers,
      teamId: null,
      ready: false,
      error:
        'Dispatcher team id missing. Set DISPATCHER_TEAM_ID in .env (your prod team UUID from floyo.ai).',
    };
  }

  return { headers, teamId, ready: true };
}

/**
 * Build auth headers for the Floyo global dispatcher (single request / sync path).
 */
export async function buildDispatcherAuth(
  workflowDb?: SupabaseClient,
  workflowId?: string
): Promise<DispatcherAuthResult> {
  const snapshot = await prepareQueueAuth(workflowDb, workflowId);
  return buildDispatcherAuthFromSnapshot(snapshot, workflowDb, workflowId);
}
