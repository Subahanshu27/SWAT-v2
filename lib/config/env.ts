/**
 * Centralized environment configuration for SWAT2.
 */

export const env = {
  supabase: {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL || '',
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '',
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    cookieDomain: process.env.SUPABASE_COOKIE_DOMAIN || '',
    dataUrl: process.env.SUPABASE_DATA_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '',
    dataServiceRoleKey:
      process.env.SUPABASE_DATA_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      '',
  },

  app: {
    url:
      process.env.NEXT_PUBLIC_APP_URL ||
      (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:3000'),
  },

  host: {
    url:
      process.env.NEXT_PUBLIC_MAIN_SITE_DOMAIN ||
      (process.env.NODE_ENV === 'production' ? 'floyo.ai' : 'dev.floyo.ai'),
  },

  mainSite: {
    domain:
      process.env.NEXT_PUBLIC_MAIN_SITE_DOMAIN ||
      (process.env.NODE_ENV === 'production'
        ? 'https://floyo.ai'
        : 'https://dev.floyo.ai'),
  },

  dispatcher: {
    url: process.env.NEXT_PUBLIC_GLOBAL_DISPATCHER_URL || '',
    teamId: process.env.DISPATCHER_TEAM_ID || '',
    /** Floyo user UUID used for workflow_run attribution via x-user-id. */
    userId: process.env.DISPATCHER_USER_ID || '',
    /**
     * Shared machine secret with global-dispatcher (x-backend-token).
     * Prefer DISPATCHER_BACKEND_TOKEN; BACKEND_TOKEN accepted as alias.
     */
    backendToken:
      process.env.DISPATCHER_BACKEND_TOKEN || process.env.BACKEND_TOKEN || '',
  },

  // Optional runtime prompt generation service. When set, SWAT2 asks this
  // service to build a fresh Comfy API prompt from a workflow_json, instead of
  // trusting the stored `workflows.prompt` column (which can be stale).
  promptService: {
    url: process.env.FLOYO_PROMPT_SERVICE_URL || '',
  },

  preflight: {
    concurrency: Math.max(1, Number(process.env.SWAT_PREFLIGHT_CONCURRENCY || 8) || 8),
  },

  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',
  isDevelopment: process.env.NODE_ENV === 'development',
} as const;

export function validateEnv(): void {
  const required = ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0 && env.isProduction) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}
