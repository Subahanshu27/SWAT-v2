// Service-role Supabase client for trusted server-side reads (no user session).
import 'server-only';
import { createClient } from '@supabase/supabase-js';

const dataUrl = process.env.SUPABASE_DATA_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceRoleKey =
  process.env.SUPABASE_DATA_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  '';

export const adminClient = createClient(
  dataUrl,
  serviceRoleKey,
  {
    auth: { persistSession: false },
    global: {
      headers: serviceRoleKey ? { Authorization: `Bearer ${serviceRoleKey}` } : {},
    },
  }
);

export const supabase = adminClient;
