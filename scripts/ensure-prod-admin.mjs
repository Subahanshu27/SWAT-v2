/**
 * Grant SWAT admin on prod for an email.
 *
 *   node scripts/ensure-prod-admin.mjs subhanshu@floyo.ai
 *
 * Uses SWAT_ADMIN_USER_ID from .env when listUsers is unavailable (new sb_secret_ keys).
 */
import { createClient } from '@supabase/supabase-js';

try {
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(new URL('../.env', import.meta.url));
  }
} catch {
  /* no .env */
}

const email = (process.argv[2] || 'subhanshu@floyo.ai').trim().toLowerCase();
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const envUserId = process.env.SWAT_ADMIN_USER_ID?.trim();

if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in Swat_Prod/.env');
  process.exit(1);
}

const sb = createClient(url, key, { auth: { persistSession: false } });

async function findUser() {
  if (envUserId) {
    const { data, error } = await sb.auth.admin.getUserById(envUserId);
    if (!error && data?.user) return data.user;
    if (error) console.warn('getUserById failed:', error.message);
  }

  let page = 1;
  for (;;) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) {
      console.warn(`listUsers page ${page} failed:`, error.message);
      break;
    }
    const hit = (data?.users ?? []).find((u) => (u.email || '').toLowerCase() === email);
    if (hit) return hit;
    if (!data?.users?.length || data.users.length < 1000) break;
    page += 1;
    if (page > 100) break;
  }

  return null;
}

const user = await findUser();

if (!user) {
  console.error(`Could not resolve prod user for ${email}.`);
  if (!envUserId) {
    console.error('Tip: set SWAT_ADMIN_USER_ID in Swat_Prod/.env (prod auth.users id) and retry.');
  }
  process.exit(1);
}

const { data: existing } = await sb
  .from('users_metadata')
  .select('user_id, role, selected_team_id')
  .eq('user_id', user.id)
  .maybeSingle();

const patch = {
  user_id: user.id,
  role: 'admin',
  selected_team_id: existing?.selected_team_id ?? process.env.DISPATCHER_TEAM_ID ?? null,
};

const { error: upsertError } = await sb.from('users_metadata').upsert(patch, { onConflict: 'user_id' });
if (upsertError) {
  console.error('users_metadata upsert failed:', upsertError.message);
  process.exit(1);
}

console.log('OK — prod SWAT admin enabled');
console.log({
  email: user.email,
  userId: user.id,
  role: patch.role,
  teamId: patch.selected_team_id || '(pick a team in Floyo UI once)',
});
