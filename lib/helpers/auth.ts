import 'server-only';
import { createClient } from '@/lib/supabase/server';
import { AuthUser } from '@/types';

/**
 * Resolve the current authenticated user along with role + selected team.
 * Returns null when there is no valid session.
 */
export async function getCurrentUser(): Promise<AuthUser | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const { data: metadata } = await supabase
    .from('users_metadata')
    .select('role, selected_team_id')
    .eq('user_id', user.id)
    .maybeSingle();

  return {
    id: user.id,
    email: user.email,
    role: metadata?.role,
    teamId: metadata?.selected_team_id ?? null,
  };
}

/**
 * Guard helper for API routes. Returns the user when they are an authenticated
 * admin, otherwise an error string describing why access is denied.
 */
export async function requireAdmin(): Promise<
  { ok: true; user: AuthUser } | { ok: false; status: number; error: string }
> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, status: 401, error: 'Not authenticated' };
  if (user.role !== 'admin') return { ok: false, status: 403, error: 'Admin access required' };
  return { ok: true, user };
}
