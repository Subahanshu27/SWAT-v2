'use client';

import { useMemo, useState } from 'react';
import { ErrorCategory, PreflightItem, PreflightResult } from '@/types';
import { CATEGORY_LABEL, categoryColor } from './format';
import { isRecheckableCategory } from './recheck';

type PreflightView = 'blocked' | 'queueable' | 'all';

interface PreflightModalProps {
  preflight: PreflightResult;
  onClose: () => void;
  onRecheckOne: (workflowId: string, category: string) => void;
  onRecheckAllStale: () => void;
  onSkipBlocked: () => void;
  recheckingId: string | null;
  recheckingAll: boolean;
}

const BASELINE_CATEGORIES: ErrorCategory[] = [
  'prompt_baseline_missing',
  'prompt_baseline_stale',
  'prompt_baseline_outdated',
  'community_input_missing',
  'invalid_prompt_files',
];

function countByCategory(items: PreflightItem[], blocked: boolean) {
  const counts = new Map<ErrorCategory, number>();
  for (const item of items) {
    if (blocked ? !item.queueable : item.queueable) continue;
    counts.set(item.category, (counts.get(item.category) || 0) + 1);
  }
  return counts;
}

export function PreflightModal({
  preflight,
  onClose,
  onRecheckOne,
  onRecheckAllStale,
  onSkipBlocked,
  recheckingId,
  recheckingAll,
}: PreflightModalProps) {
  const [view, setView] = useState<PreflightView>('blocked');
  const [categoryFilter, setCategoryFilter] = useState<ErrorCategory | 'all'>('all');
  const [search, setSearch] = useState('');

  const blockedItems = useMemo(
    () => preflight.items.filter((i) => !i.queueable),
    [preflight.items]
  );
  const queueableItems = useMemo(
    () => preflight.items.filter((i) => i.queueable),
    [preflight.items]
  );

  const blockedByCategory = useMemo(() => countByCategory(preflight.items, true), [preflight.items]);

  const filteredItems = useMemo(() => {
    let list =
      view === 'blocked' ? blockedItems : view === 'queueable' ? queueableItems : preflight.items;
    if (categoryFilter !== 'all') {
      list = list.filter((i) => i.category === categoryFilter);
    }
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (i) => i.name.toLowerCase().includes(q) || i.workflowId.toLowerCase().includes(q)
      );
    }
    return list;
  }, [view, categoryFilter, search, blockedItems, queueableItems, preflight.items]);

  const categoryFilters = useMemo(() => {
    const source = view === 'queueable' ? queueableItems : view === 'all' ? preflight.items : blockedItems;
    const counts = new Map<ErrorCategory, number>();
    for (const item of source) {
      counts.set(item.category, (counts.get(item.category) || 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [view, blockedItems, queueableItems, preflight.items]);

  const hasBaselineIssues = blockedItems.some((i) => BASELINE_CATEGORIES.includes(i.category));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
          <div>
            <h3 className="text-lg font-semibold text-slate-100">Preflight report</h3>
            <p className="mt-0.5 text-xs text-slate-500">
              {preflight.total} workflows · {preflight.queueable} queueable · {preflight.blocked}{' '}
              blocked
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-md border border-slate-700 px-3 py-1 text-sm text-slate-300 hover:bg-slate-800"
          >
            Close
          </button>
        </div>

        {preflight.blocked > 0 && (
          <div className="flex flex-wrap gap-2 border-b border-slate-800 px-6 py-3">
            {Array.from(blockedByCategory.entries())
              .sort((a, b) => b[1] - a[1])
              .map(([category, count]) => (
                <span
                  key={category}
                  className={`rounded-full border px-2.5 py-1 text-xs ${categoryColor(category)}`}
                >
                  {CATEGORY_LABEL[category]} · {count}
                </span>
              ))}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 px-6 py-3">
          {(['blocked', 'queueable', 'all'] as PreflightView[]).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => {
                setView(v);
                setCategoryFilter('all');
              }}
              className={`rounded-full border px-3 py-1 text-xs ${
                view === v
                  ? 'border-indigo-500/60 bg-indigo-500/10 text-indigo-200'
                  : 'border-slate-700 text-slate-400 hover:bg-slate-800'
              }`}
            >
              {v === 'blocked' && `Blocked (${preflight.blocked})`}
              {v === 'queueable' && `Queueable (${preflight.queueable})`}
              {v === 'all' && `All (${preflight.total})`}
            </button>
          ))}
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or ID…"
            className="ml-auto min-w-[200px] flex-1 rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100 outline-none focus:border-indigo-500 sm:max-w-xs sm:flex-none"
          />
        </div>

        {categoryFilters.length > 1 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 px-6 py-2">
            <span className="text-xs text-slate-500">Category:</span>
            <button
              type="button"
              onClick={() => setCategoryFilter('all')}
              className={`rounded-md border px-2 py-0.5 text-xs ${
                categoryFilter === 'all'
                  ? 'border-slate-500 text-slate-200'
                  : 'border-slate-800 text-slate-500 hover:bg-slate-800'
              }`}
            >
              All
            </button>
            {categoryFilters.map(([category, count]) => (
              <button
                key={category}
                type="button"
                onClick={() => setCategoryFilter(category)}
                className={`rounded-md border px-2 py-0.5 text-xs ${
                  categoryFilter === category
                    ? categoryColor(category)
                    : 'border-slate-800 text-slate-500 hover:bg-slate-800'
                }`}
              >
                {CATEGORY_LABEL[category]} ({count})
              </button>
            ))}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto px-6 py-3">
          <div className="mb-2 text-xs text-slate-500">
            Showing {filteredItems.length} workflow{filteredItems.length === 1 ? '' : 's'}
          </div>
          <ul className="space-y-2">
            {filteredItems.map((item) => (
              <li
                key={item.workflowId}
                className={`rounded-lg border px-3 py-2.5 ${
                  item.queueable
                    ? 'border-emerald-500/20 bg-emerald-500/5'
                    : 'border-slate-800 bg-slate-950/40'
                }`}
              >
                <div className="flex flex-wrap items-start gap-2">
                  <span
                    className={`shrink-0 rounded border px-1.5 py-0.5 text-[11px] ${categoryColor(item.category)}`}
                  >
                    {CATEGORY_LABEL[item.category]}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-slate-100">{item.name}</div>
                    {item.reason && (
                      <div className="mt-0.5 text-xs text-slate-400">{item.reason}</div>
                    )}
                    <div className="mt-1 font-mono text-[10px] text-slate-600">{item.workflowId}</div>
                  </div>
                  {isRecheckableCategory(item.category) && (
                    <button
                      type="button"
                      onClick={() => onRecheckOne(item.workflowId, item.category)}
                      disabled={recheckingId === item.workflowId || recheckingAll}
                      className="shrink-0 rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800 disabled:opacity-50"
                    >
                      {recheckingId === item.workflowId ? '⟳ Checking…' : '↻ Re-check'}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {filteredItems.length === 0 && (
            <div className="py-12 text-center text-sm text-slate-500">No workflows match this filter.</div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-800 px-6 py-4">
          <p className="max-w-xl text-xs text-slate-500">
            {hasBaselineIssues && (
              <>
                <strong className="text-slate-400">Needs baseline</strong> = no trusted Floyo UI run yet.
                Fix in Floyo editor: Run + Publish, then Re-check here. A SWAT batch run alone does not
                create a baseline.
              </>
            )}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {preflight.blocked > 0 && (
              <>
                <button
                  type="button"
                  onClick={onRecheckAllStale}
                  disabled={recheckingAll}
                  className="rounded-md border border-violet-500/40 px-3 py-1.5 text-xs text-violet-200 hover:bg-violet-500/10 disabled:opacity-50"
                >
                  {recheckingAll ? '⟳ Re-checking all stale…' : '↻ Re-check all stale'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onSkipBlocked();
                    onClose();
                  }}
                  className="rounded-md border border-amber-500/40 px-3 py-1.5 text-xs text-amber-200 hover:bg-amber-500/10"
                >
                  Skip all blocked for run
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
