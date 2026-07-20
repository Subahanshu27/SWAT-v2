import {
  ApiResponse,
  BatchDetail,
  BatchSummary,
  Paginated,
  PreflightResult,
  WorkflowCatalogStats,
  WorkflowListItem,
} from '@/types';
import { WorkflowRunDetails } from '@/lib/services/workflow-run.service';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    cache: 'no-store',
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  const json = (await res.json()) as ApiResponse<T>;
  if (!res.ok || !json.success) {
    throw new Error(json.error || `Request failed (${res.status})`);
  }
  return json.data as T;
}

export const api = {
  me: () => request<{ id: string; email?: string; role?: string; teamId?: string | null }>(
    '/api/auth/me'
  ),

  listBatches: (page = 1, pageSize = 20) =>
    request<Paginated<BatchSummary>>(`/api/batches?page=${page}&pageSize=${pageSize}`),

  syncAllBatches: () =>
    request<{ checked: number; updated: number; batchesUpdated: number }>('/api/batches/sync-all', {
      method: 'POST',
    }),

  getBatch: (batchId: string) => request<BatchDetail>(`/api/batches/${batchId}`),

  syncBatch: (batchId: string) =>
    request<BatchDetail>(`/api/batches/${batchId}/sync`, { method: 'POST' }),

  preflight: (batchId: string) =>
    request<PreflightResult>(`/api/batches/${batchId}/preflight`, { method: 'POST' }),

  listWorkflows: (params: {
    page?: number;
    pageSize?: number;
    search?: string;
    verifiedOnly?: boolean;
    includePrivate?: boolean;
  }) => {
    const qs = new URLSearchParams();
    if (params.page) qs.set('page', String(params.page));
    if (params.pageSize) qs.set('pageSize', String(params.pageSize));
    if (params.search) qs.set('search', params.search);
    if (params.verifiedOnly) qs.set('verifiedOnly', 'true');
    if (params.includePrivate) qs.set('includePrivate', 'true');
    return request<Paginated<WorkflowListItem>>(`/api/workflows?${qs.toString()}`);
  },

  workflowCatalogStats: (includePrivate = false) => {
    const qs = new URLSearchParams();
    if (includePrivate) qs.set('includePrivate', 'true');
    return request<WorkflowCatalogStats>(`/api/workflows/stats?${qs.toString()}`);
  },

  createBatch: (body: {
    name: string;
    sequence?: string;
    workflowIds: string[];
    runImmediately?: boolean;
  }) =>
    request<{ batch: BatchSummary }>('/api/batches', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  queueBatch: (batchId: string, body: { workflowIds?: string[]; sequence?: string } = {}) =>
    request<{ results: unknown[] }>(`/api/batches/${batchId}/queue`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  removeBatchWorkflows: (batchId: string, workflowIds: string[]) =>
    request<{ removed: number; notRemovable: number }>(`/api/batches/${batchId}/workflows`, {
      method: 'DELETE',
      body: JSON.stringify({ workflowIds }),
    }),

  runDetails: (batchWorkflowId: string) =>
    request<WorkflowRunDetails>(`/api/workflow-runs/${batchWorkflowId}`),

  recheckWorkflow: (workflowId: string, previousCategory: string) =>
    request<{
      workflow_id: string;
      previous_category: string;
      new_category: string;
      changed: boolean;
      message: string;
      queueable: boolean;
    }>(`/api/workflows/${workflowId}/recheck`, {
      method: 'POST',
      body: JSON.stringify({ previousCategory }),
    }),
};
