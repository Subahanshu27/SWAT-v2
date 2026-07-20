'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { WorkflowListItem } from '@/types';
import { api } from './api';

interface NewBatchModalProps {
  onClose: () => void;
  onCreated: (batchId: string) => void;
}

const PAGE_SIZE = 25;
const BULK_PAGE_SIZE = 100;

const SEQUENCE_OPTIONS = [
  { label: '1 second between queues', value: '1 Each Seconds' },
  { label: '5 seconds between queues', value: '5 Each Seconds' },
  { label: '10 seconds between queues', value: '10 Each Seconds' },
  { label: '15 seconds between queues', value: '15 Each Seconds' },
  { label: '30 seconds between queues', value: '30 Each Seconds' },
  { label: '60 seconds between queues', value: '60 Each Seconds' },
] as const;

const QUICK_PICK_SIZES = [50, 100, 200, 300] as const;

export function NewBatchModal({ onClose, onCreated }: NewBatchModalProps) {
  const [name, setName] = useState('');
  const [sequence, setSequence] = useState<string>(SEQUENCE_OPTIONS[0].value);
  const [runImmediately, setRunImmediately] = useState(false);

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [verifiedOnly, setVerifiedOnly] = useState(true);
  const [includePrivate, setIncludePrivate] = useState(false);

  const [items, setItems] = useState<WorkflowListItem[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [bulkSelectBusy, setBulkSelectBusy] = useState(false);
  const [bulkSelectLabel, setBulkSelectLabel] = useState<string | null>(null);

  const [selected, setSelected] = useState<Map<string, WorkflowListItem>>(new Map());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [catalogStats, setCatalogStats] = useState<{
    verifiedCount: number;
    notVerifiedCount: number;
    totalActive: number;
  } | null>(null);

  const listFilters = useMemo(
    () => ({
      search: debouncedSearch || undefined,
      verifiedOnly,
      includePrivate,
    }),
    [debouncedSearch, verifiedOnly, includePrivate]
  );

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 350);
    return () => clearTimeout(t);
  }, [search]);

  const loadCatalogStats = useCallback(async () => {
    try {
      const stats = await api.workflowCatalogStats(includePrivate);
      setCatalogStats({
        verifiedCount: stats.verifiedCount,
        notVerifiedCount: stats.notVerifiedCount,
        totalActive: stats.totalActive,
      });
    } catch {
      setCatalogStats(null);
    }
  }, [includePrivate]);

  const fetchAllMatching = useCallback(async (): Promise<WorkflowListItem[]> => {
    const collected: WorkflowListItem[] = [];
    let nextPage = 1;
    let more = true;

    while (more) {
      const res = await api.listWorkflows({
        page: nextPage,
        pageSize: BULK_PAGE_SIZE,
        ...listFilters,
      });
      collected.push(...res.items);
      more = res.hasMore;
      nextPage = res.page + 1;
    }

    return collected;
  }, [listFilters]);

  const loadPage = useCallback(
    async (nextPage: number, replace: boolean) => {
      setLoading(true);
      try {
        const res = await api.listWorkflows({
          page: nextPage,
          pageSize: PAGE_SIZE,
          ...listFilters,
        });
        setItems((prev) => (replace ? res.items : [...prev, ...res.items]));
        setTotal(res.total);
        setHasMore(res.hasMore);
        setPage(res.page);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [listFilters]
  );

  useEffect(() => {
    setSelected(new Map());
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadPage(1, true);
  }, [loadPage]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadCatalogStats();
  }, [loadCatalogStats]);

  const mergeIntoSelection = (workflows: WorkflowListItem[], replace = false) => {
    setSelected((prev) => {
      const next = replace ? new Map<string, WorkflowListItem>() : new Map(prev);
      workflows.forEach((wf) => next.set(wf.id, wf));
      return next;
    });
  };

  const toggle = (wf: WorkflowListItem) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(wf.id)) next.delete(wf.id);
      else next.set(wf.id, wf);
      return next;
    });
  };

  const selectLoaded = () => {
    mergeIntoSelection(items);
    setBulkSelectLabel(`Added ${items.length} loaded workflows`);
  };

  const selectAllMatching = async () => {
    setBulkSelectBusy(true);
    setBulkSelectLabel(null);
    setError(null);
    try {
      const all = await fetchAllMatching();
      mergeIntoSelection(all, true);
      setBulkSelectLabel(`Selected all ${all.length} matching workflows`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBulkSelectBusy(false);
    }
  };

  const selectSlice = async (offset: number, count: number) => {
    setBulkSelectBusy(true);
    setBulkSelectLabel(null);
    setError(null);
    try {
      const all = await fetchAllMatching();
      const slice = all.slice(offset, offset + count);
      if (slice.length === 0) {
        setError(`No workflows in range ${offset + 1}–${offset + count} (total matching: ${all.length})`);
        return;
      }
      mergeIntoSelection(slice, true);
      setBulkSelectLabel(`Selected workflows ${offset + 1}–${offset + slice.length} of ${all.length}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBulkSelectBusy(false);
    }
  };

  const selectFirstN = (count: number) => selectSlice(0, count);

  const clearSelection = () => {
    setSelected(new Map());
    setBulkSelectLabel(null);
  };

  const selectedList = useMemo(() => Array.from(selected.values()), [selected]);

  const handleCreate = async () => {
    if (!name.trim() || selectedList.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const { batch } = await api.createBatch({
        name: name.trim(),
        sequence,
        workflowIds: selectedList.map((w) => w.id),
        runImmediately,
      });
      onCreated(batch.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const allLoadedSelected = items.length > 0 && items.every((wf) => selected.has(wf.id));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
          <h3 className="text-lg font-semibold text-slate-100">New batch</h3>
          <button onClick={onClose} className="rounded-md border border-slate-700 px-3 py-1 text-sm text-slate-300 hover:bg-slate-800">
            Close
          </button>
        </div>

        <div className="grid gap-3 border-b border-slate-800 px-6 py-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-slate-400">Batch name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Weekly regression"
              className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-indigo-500"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-slate-400">Delay between queues</span>
            <select
              value={sequence}
              onChange={(e) => setSequence(e.target.value)}
              className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-indigo-500"
            >
              {SEQUENCE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-b border-slate-800 px-6 py-3">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search workflows by name..."
            className="min-w-[200px] flex-1 rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-indigo-500"
          />
          <label className="flex items-center gap-2 text-xs text-slate-300" title="Show only verified_to_run public workflows">
            <input type="checkbox" checked={verifiedOnly} onChange={(e) => setVerifiedOnly(e.target.checked)} />
            Verified public only
          </label>
          <label className="flex items-center gap-2 text-xs text-slate-300" title="Include is_private workflows">
            <input type="checkbox" checked={includePrivate} onChange={(e) => setIncludePrivate(e.target.checked)} />
            Include private
          </label>
        </div>

        <div className="space-y-2 border-b border-slate-800 px-6 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-slate-400">Quick select:</span>
            <button
              type="button"
              onClick={selectLoaded}
              disabled={bulkSelectBusy || items.length === 0}
              className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-50"
            >
              Loaded ({items.length})
            </button>
            <button
              type="button"
              onClick={selectAllMatching}
              disabled={bulkSelectBusy || total === 0}
              className="rounded-md border border-indigo-500/40 px-2 py-1 text-xs text-indigo-200 hover:bg-indigo-500/10 disabled:opacity-50"
            >
              All matching ({total})
            </button>
            {QUICK_PICK_SIZES.map((n) => (
              <button
                key={`first-${n}`}
                type="button"
                onClick={() => selectFirstN(n)}
                disabled={bulkSelectBusy || total === 0}
                className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-50"
              >
                First {n}
              </button>
            ))}
            <button
              type="button"
              onClick={() => selectSlice(300, 300)}
              disabled={bulkSelectBusy || total === 0}
              className="rounded-md border border-emerald-500/40 px-2 py-1 text-xs text-emerald-200 hover:bg-emerald-500/10 disabled:opacity-50"
              title="Select workflows 301–600 (same filter order as First 300)"
            >
              Next 300
            </button>
            <button
              type="button"
              onClick={clearSelection}
              disabled={bulkSelectBusy || selected.size === 0}
              className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-400 hover:bg-slate-800 disabled:opacity-50"
            >
              Clear
            </button>
          </div>
          {bulkSelectBusy && (
            <p className="text-xs text-indigo-300">Loading full catalog for bulk select…</p>
          )}
          {bulkSelectLabel && !bulkSelectBusy && (
            <p className="text-xs text-emerald-400">{bulkSelectLabel}</p>
          )}
          <p className="text-xs text-slate-500">
            Tip: verified filter ON → <strong className="text-slate-400">First 300</strong> for batch 1, create it, open New batch again →{' '}
            <strong className="text-slate-400">Next 300</strong> for batch 2.
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-6 py-3">
          {catalogStats && (
            <div className="mb-2 text-xs text-slate-500">
              Catalog: {catalogStats.verifiedCount} verified · {catalogStats.notVerifiedCount} unverified ·{' '}
              {catalogStats.totalActive} public active
            </div>
          )}
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
            <span>
              Showing {items.length} of {total} matching • {selected.size} selected
            </span>
            <label className="flex items-center gap-2 text-slate-300">
              <input
                type="checkbox"
                checked={allLoadedSelected && items.length > 0}
                onChange={(e) => (e.target.checked ? selectLoaded() : clearSelection())}
              />
              Toggle loaded
            </label>
          </div>
          <div className="space-y-1">
            {items.map((wf) => {
              const checked = selected.has(wf.id);
              return (
                <button
                  key={wf.id}
                  type="button"
                  onClick={() => toggle(wf)}
                  className={`flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left text-sm transition ${
                    checked
                      ? 'border-indigo-500/60 bg-indigo-500/10'
                      : 'border-slate-800 hover:border-slate-700 hover:bg-slate-800/50'
                  }`}
                >
                  <input type="checkbox" readOnly checked={checked} />
                  <span className="min-w-0 flex-1 truncate text-slate-100">{wf.name}</span>
                  {wf.verified && <span className="text-[11px] text-emerald-400">verified</span>}
                  {wf.isPrivate && <span className="text-[11px] text-amber-400">private</span>}
                </button>
              );
            })}
          </div>

          {hasMore && (
            <button
              type="button"
              onClick={() => loadPage(page + 1, false)}
              disabled={loading}
              className="mt-3 w-full rounded-md border border-slate-700 py-2 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-50"
            >
              {loading ? 'Loading...' : 'Load more'}
            </button>
          )}
          {!hasMore && items.length === 0 && !loading && (
            <div className="py-8 text-center text-sm text-slate-500">No workflows match your filters.</div>
          )}
        </div>

        <div className="flex items-center justify-between gap-4 border-t border-slate-800 px-6 py-4">
          <label className="flex items-center gap-2 text-sm text-slate-300">
            <input type="checkbox" checked={runImmediately} onChange={(e) => setRunImmediately(e.target.checked)} />
            Run immediately after creating
          </label>
          <div className="flex items-center gap-3">
            {error && <span className="max-w-xs text-xs text-red-400">{error}</span>}
            <button
              type="button"
              onClick={handleCreate}
              disabled={submitting || bulkSelectBusy || !name.trim() || selected.size === 0}
              className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? 'Creating...' : `Create batch (${selected.size})`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
