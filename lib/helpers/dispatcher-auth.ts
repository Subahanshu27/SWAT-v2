import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { env } from '@/lib/config/env';

export interface DispatcherAuthResult {
  headers: Record<string, string>;
  teamId: string | null;
  ready: boolean;
  error?: string;
}

/**
 * Captured at queue start. Backend-token auth does not expire, so long batch
 * runs no longer depend on browser Supabase cookies / JWTs.
 */
export interface QueueAuthSnapshot {
  backendToken: string | null;
  teamId: string | null;
  userId: string | null;
}

function authHeadersFromSnapshot(snapshot: QueueAuthSnapshot): Record<string, string> {
  const headers: Record<string, string> = {};

  if (env.dispatcher.url) {
    headers.host = new URL(env.dispatcher.url).host;
  }

  if (snapshot.backendToken) {
    headers['x-backend-token'] = snapshot.backendToken;
  }
  if (snapshot.userId) {
    headers['x-user-id'] = snapshot.userId;
  }
  if (snapshot.teamId) {
    headers['x-team-id'] = snapshot.teamId;
  }

  return headers;
}

/**
 * Capture dispatcher auth at the start of a queue request.
 * Uses machine credentials from env (not the operator's browser session).
 */
export async function prepareQueueAuth(
  _workflowDb?: SupabaseClient,
  _workflowId?: string
): Promise<QueueAuthSnapshot> {
  return {
    backendToken: env.dispatcher.backendToken.trim() || null,
    teamId: env.dispatcher.teamId.trim() || null,
    userId: env.dispatcher.userId.trim() || null,
  };
}

/** No-op for backend-token auth (credentials do not expire). */
export async function ensureFreshQueueAuth(snapshot: QueueAuthSnapshot): Promise<QueueAuthSnapshot> {
  return snapshot;
}

export async function buildDispatcherAuthFromSnapshot(
  snapshot: QueueAuthSnapshot,
  _workflowDb?: SupabaseClient,
  _workflowId?: string
): Promise<DispatcherAuthResult> {
  if (!env.dispatcher.url) {
    return { headers: {}, teamId: null, ready: false, error: 'Dispatcher URL is not configured' };
  }

  const headers = authHeadersFromSnapshot(snapshot);
  const teamId = snapshot.teamId;

  if (!snapshot.backendToken) {
    return {
      headers,
      teamId,
      ready: false,
      error:
        'Dispatcher backend token missing. Set DISPATCHER_BACKEND_TOKEN (or BACKEND_TOKEN) in .env to match the global-dispatcher BACKEND_TOKEN.',
    };
  }

  if (!teamId) {
    return {
      headers,
      teamId: null,
      ready: false,
      error: 'Dispatcher team id missing. Set DISPATCHER_TEAM_ID in .env.',
    };
  }

  if (!snapshot.userId) {
    return {
      headers,
      teamId,
      ready: false,
      error:
        'Dispatcher user id missing. Set DISPATCHER_USER_ID in .env (a Floyo user in DISPATCHER_TEAM_ID; used for run attribution).',
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
