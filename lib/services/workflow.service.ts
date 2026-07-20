import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { chunkArray } from '@/lib/helpers/chunk';
import { env } from '@/lib/config/env';
import { Paginated, WorkflowCatalogStats, WorkflowListItem } from '@/types';

const IN_QUERY_CHUNK = 100;

interface WorkflowRow {
  id: string;
  name: string | null;
  overview: string | null;
  images: unknown;
  is_private: boolean | null;
  verified_to_run: boolean | null;
  created_at: string | null;
}

function buildImageUrl(workflowId: string, images: unknown): string | undefined {
  if (!Array.isArray(images) || images.length === 0) return undefined;
  const first = images[0];
  if (typeof first === 'string') return first;
  if (first && typeof first === 'object') {
    const obj = first as { filename?: string; url?: string; src?: string };
    if (obj.url || obj.src) return obj.url || obj.src;
    if (obj.filename) {
      const match = env.supabase.dataUrl.match(/https?:\/\/([^.]+)\.supabase\.co/);
      if (!match) return undefined;
      return `https://${match[1]}.supabase.co/storage/v1/object/public/floyo/workflows/${workflowId}/images/${obj.filename}`;
    }
  }
  return undefined;
}

function mapRow(row: WorkflowRow): WorkflowListItem {
  return {
    id: row.id,
    name: row.name || 'Untitled workflow',
    description: row.overview || undefined,
    image: buildImageUrl(row.id, row.images),
    verified: !!row.verified_to_run,
    isPrivate: !!row.is_private,
    createdAt: row.created_at || undefined,
  };
}

export interface ListWorkflowsParams {
  page?: number;
  pageSize?: number;
  search?: string;
  verifiedOnly?: boolean;
  includePrivate?: boolean;
}

type CatalogFilterParams = Pick<ListWorkflowsParams, 'verifiedOnly' | 'includePrivate'>;

function withCatalogFilters<Q extends { is: (col: string, val: null) => Q; eq: (col: string, val: boolean) => Q }>(
  query: Q,
  params: CatalogFilterParams
): Q {
  let filtered = query.is('deleted_at', null);
  if (!params.includePrivate) {
    filtered = filtered.eq('is_private', false);
  }
  if (params.verifiedOnly) {
    filtered = filtered.eq('verified_to_run', true);
  }
  return filtered;
}

/**
 * Headline counts for the workflow picker toggles.
 *
 * Equivalent SQL (public catalog):
 *   SELECT
 *     COUNT(*) FILTER (WHERE verified_to_run = true) AS verified_count,
 *     COUNT(*) FILTER (WHERE verified_to_run IS NOT TRUE) AS not_verified_count,
 *     COUNT(*) AS total_active
 *   FROM workflows
 *   WHERE deleted_at IS NULL AND is_private = false;
 */
export async function getWorkflowCatalogStats(
  client: SupabaseClient,
  params: Pick<ListWorkflowsParams, 'includePrivate'> = {}
): Promise<WorkflowCatalogStats> {
  const includePrivate = params.includePrivate ?? false;

  let totalQuery = client
    .from('workflows')
    .select('id', { count: 'exact', head: true })
    .is('deleted_at', null);
  if (!includePrivate) {
    totalQuery = totalQuery.eq('is_private', false);
  }

  let verifiedQuery = client
    .from('workflows')
    .select('id', { count: 'exact', head: true })
    .is('deleted_at', null)
    .eq('verified_to_run', true);
  if (!includePrivate) {
    verifiedQuery = verifiedQuery.eq('is_private', false);
  }

  const [totalRes, verifiedRes] = await Promise.all([totalQuery, verifiedQuery]);
  if (totalRes.error) throw totalRes.error;
  if (verifiedRes.error) throw verifiedRes.error;

  const totalActive = totalRes.count ?? 0;
  const verifiedCount = verifiedRes.count ?? 0;

  return {
    verifiedCount,
    notVerifiedCount: Math.max(0, totalActive - verifiedCount),
    totalActive,
    includePrivate,
  };
}

/**
 * Server-side paginated + searchable workflow catalog.
 *
 * Unlike the old SWAT which loaded every workflow into memory, this queries
 * only the requested page with a lightweight column set and an exact count.
 */
export async function listWorkflows(
  client: SupabaseClient,
  params: ListWorkflowsParams = {}
): Promise<Paginated<WorkflowListItem>> {
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 25));
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  type CatalogQuery = Parameters<typeof withCatalogFilters>[0] & {
    order: (col: string, opts: { ascending: boolean }) => CatalogQuery;
    range: (from: number, to: number) => CatalogQuery;
    ilike: (col: string, pattern: string) => CatalogQuery;
  };

  const workflows = (client as unknown as {
    from: (table: 'workflows') => {
      select: (columns: string, opts?: { count?: 'exact' }) => CatalogQuery;
    };
  }).from('workflows');

  let query = withCatalogFilters(
    workflows.select('id, name, overview, images, is_private, verified_to_run, created_at', {
      count: 'exact',
    }),
    params
  )
    .order('created_at', { ascending: false })
    .range(from, to);

  if (params.search && params.search.trim().length > 0) {
    query = query.ilike('name', `%${params.search.trim()}%`);
  }

  const { data, error, count } = await (query as unknown as PromiseLike<{
    data: WorkflowRow[] | null;
    error: { message: string } | null;
    count: number | null;
  }>);
  if (error) throw error;

  const items = (data as WorkflowRow[] | null)?.map(mapRow) ?? [];
  const total = count ?? items.length;

  return {
    items,
    total,
    page,
    pageSize,
    hasMore: from + items.length < total,
  };
}

/**
 * Fetch the raw workflow_json + stored prompt for a set of workflow ids.
 * Used by preflight + queueing only (heavier columns kept off list queries).
 */
export async function getWorkflowDefinitions(
  client: SupabaseClient,
  workflowIds: string[]
): Promise<Array<{ id: string; name: string | null; workflow_json: unknown; prompt: unknown }>> {
  if (workflowIds.length === 0) return [];

  const rows: Array<{ id: string; name: string | null; workflow_json: unknown; prompt: unknown }> = [];
  for (const chunk of chunkArray(workflowIds, IN_QUERY_CHUNK)) {
    const { data, error } = await client
      .from('workflows')
      .select('id, name, workflow_json, prompt')
      .in('id', chunk);
    if (error) throw error;
    if (data) rows.push(...data);
  }
  return rows;
}
