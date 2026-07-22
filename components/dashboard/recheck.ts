import { PreflightItem } from '@/types';

export interface RecheckResult {
  workflow_id: string;
  previous_category: string;
  new_category: string;
  changed: boolean;
  message: string;
  queueable: boolean;
}

const STALE_CATEGORIES = [
  'prompt_baseline_missing',
  'prompt_baseline_stale',
  'prompt_baseline_outdated',
  'community_input_missing',
  'invalid_prompt_files',
];

export function isRecheckableCategory(category: string): boolean {
  return STALE_CATEGORIES.includes(category);
}

async function fetchRecheck(workflowId: string, previousCategory: string): Promise<RecheckResult> {
  const res = await fetch(`/api/workflows/${workflowId}/recheck`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ previousCategory }),
  });
  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(json.error || `Re-check failed (${res.status})`);
  }
  return json.data as RecheckResult;
}

/** Re-run preflight for a single workflow via the SWAT API. */
export async function recheckWorkflow(
  workflowId: string,
  previousCategory: string
): Promise<RecheckResult> {
  return fetchRecheck(workflowId, previousCategory);
}

/** Re-check all workflows matching target categories. */
export async function recheckByCategory(
  items: Array<{ workflowId: string; category: string }>,
  targetCategories: string[] = STALE_CATEGORIES
): Promise<RecheckResult[]> {
  const toRecheck = items.filter((w) => targetCategories.includes(w.category));
  const results: RecheckResult[] = [];

  for (const wf of toRecheck) {
    results.push(await fetchRecheck(wf.workflowId, wf.category));
  }

  return results;
}

/** Merge a recheck result back into preflight items and recompute counts. */
export function applyRecheckToPreflight(
  preflight: { items: PreflightItem[]; total: number; queueable: number; blocked: number },
  result: RecheckResult
): typeof preflight {
  const items = preflight.items.map((item) =>
    item.workflowId === result.workflow_id
      ? {
          ...item,
          queueable: result.queueable,
          category: result.new_category as PreflightItem['category'],
          reason: result.message || item.reason,
        }
      : item
  );
  const queueable = items.filter((i) => i.queueable).length;
  return {
    ...preflight,
    items,
    queueable,
    blocked: items.length - queueable,
  };
}
