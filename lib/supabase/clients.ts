// Swat_Prod — single prod Supabase client for auth, workflows, and swat batches.
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { adminClient } from './admin';

export const dataClient: SupabaseClient = adminClient;
export const swatClient: SupabaseClient = adminClient;

export function workflowClient(): SupabaseClient {
  return dataClient;
}
