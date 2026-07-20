'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BatchDetail, BatchSummary, BatchWorkflow, ErrorCategory, PreflightResult } from '@/types';
import { api } from './api';
import { CATEGORY_LABEL, categoryColor, formatDate, isActiveStatus, statusColor, statusLabel } from './format';
import { WorkflowTable } from './WorkflowTable';
import { RunDetailsModal } from './RunDetailsModal';
import { NewBatchModal } from './NewBatchModal';
import { PreflightModal } from './PreflightModal';
import { REQUEUEABLE_STATUSES } from '@/lib/helpers/status';
import {
  applyRecheckToPreflight,
  isRecheckableCategory,
  recheckByCategory,
  recheckWorkflow,
} from './recheck';

type WorkflowFilter = 'all' | 'failed' | 'genuine' | 'baseline' | 'noise' | 'passed';

const NOISE_CATEGORIES: ErrorCategory[] = ['invalid_workflow_json', 'prompt_generation_failed', 'infra_error'];
const BASELINE_CATEGORIES: ErrorCategory[] = [
  'prompt_baseline_missing',
  'prompt_baseline_stale',
  'prompt_baseline_outdated',
  'community_input_missing',
];

export function Dashboard() {
  const [email, setEmail] = useState<string>('');
  const [batches, setBatches] = useState<BatchSummary[]>([]);
  const [batchPage, setBatchPage] = useState(1);
  const [batchesHasMore, setBatchesHasMore] = useState(false);
  const [loadingBatches, setLoadingBatches] = useState(true);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<BatchDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [preflightCheckedAt, setPreflightCheckedAt] = useState<number | null>(null);

  const [filter, setFilter] = useState<WorkflowFilter>('all');
  const [detailWorkflow, setDetailWorkflow] = useState<BatchWorkflow | null>(null);
  const [showNewBatch, setShowNewBatch] = useState(false);
  const [showPreflightModal, setShowPreflightModal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queueing, setQueueing] = useState(false);
  const [liveSyncing, setLiveSyncing] = useState(false);
  const [recheckingId, setRecheckingId] = useState<string | null>(null);
  const [recheckingAll, setRecheckingAll] = useState(false);
  const [skippedForRun, setSkippedForRun] = useState<Set<string>>(new Set());
  const [queueableOnlyView, setQueueableOnlyView] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const batchesRef = useRef(batches);
  batchesRef.current = batches;

  useEffect(() => {
    api.me().then((u) => setEmail(u.email || '')).catch(() => undefined);
  }, []);

  const loadBatches = useCallback(async (page: number, replace: boolean) => {
    setLoadingBatches(true);
    try {
      const res = await api.listBatches(page, 20);
      setBatches((prev) => (replace ? res.items : [...prev, ...res.items]));
      setBatchesHasMore(res.hasMore);
      setBatchPage(res.page);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingBatches(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    const syncAndLoad = async () => {
      await api.syncAllBatches().catch(() => undefined);
      if (active) await loadBatches(1, true);
    };
    syncAndLoad();
    return () => {
      active = false;
    };
  }, [loadBatches]);

  const loadDetail = useCallback(async (batchId: string, silent = false, sync = false) => {
    if (!silent) setLoadingDetail(true);
    try {
      const res = sync ? await api.syncBatch(batchId) : await api.getBatch(batchId);
      setDetail(res);
      // Keep the summary list in sync with the latest aggregate status.
      setBatches((prev) => prev.map((b) => (b.id === res.id ? { ...b, ...summaryFromDetail(res) } : b)));
    } catch (err) {
      if (!silent) setError((err as Error).message);
    } finally {
      if (!silent) setLoadingDetail(false);
    }
  }, []);

  // Select a batch.
  useEffect(() => {
    if (!selectedId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDetail(null);
      return;
    }
    setPreflight(null);
    setPreflightCheckedAt(null);
    setFilter('all');
    setSkippedForRun(new Set());
    setQueueableOnlyView(false);
    const summary = batchesRef.current.find((b) => b.id === selectedId);
    const syncOnOpen =
      !!summary &&
      (summary.status === 'running' ||
        summary.status === 'queued' ||
        (summary.progress > 0 && summary.progress < 100));
    loadDetail(selectedId, false, syncOnOpen);
  }, [selectedId, loadDetail]);

  // Poll ONLY the selected batch while it is still active. This avoids the old
  // app's global aggressive polling of every batch.
  useEffect(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (!selectedId || !detail) {
      setLiveSyncing(false);
      return;
    }

    const batchInFlight = detail.status === 'running' || detail.status === 'queued';
    const hasRunIds = detail.workflows.some((w) => !!w.runId);
    const hasLiveWorkflows = detail.workflows.some(
      (w) => w.status === 'running' || w.status === 'queued' || !!w.runId
    );
    const allPendingNoRuns =
      detail.workflows.length > 0 &&
      detail.workflows.every((w) => w.status === 'pending' && !w.runId);

    const shouldPoll =
      queueing ||
      batchInFlight ||
      hasLiveWorkflows ||
      (detail.workflows.some((w) => isActiveStatus(w.status)) && !allPendingNoRuns);

    if (!shouldPoll) {
      setLiveSyncing(false);
      return;
    }

    const fastPoll =
      queueing ||
      batchInFlight ||
      detail.status === 'running' ||
      detail.workflows.some((w) => w.status === 'running' || w.status === 'queued');
    const pollMs = fastPoll ? 3000 : detail.totalWorkflows >= 150 ? 8000 : 4000;

    setLiveSyncing(true);
    void loadDetail(selectedId, true, true);
    pollRef.current = setInterval(() => {
      void loadDetail(selectedId, true, true);
    }, pollMs);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      setLiveSyncing(false);
    };
  }, [selectedId, detail, loadDetail, queueing]);

  const runPreflight = async () => {
    if (!selectedId || preflightLoading) return;
    setPreflightLoading(true);
    setError(null);
    try {
      const result = await api.preflight(selectedId);
      setPreflight(result);
      setPreflightCheckedAt(Date.now());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPreflightLoading(false);
    }
  };

  const requeueableWorkflows = useMemo(
    () => detail?.workflows.filter((w) => REQUEUEABLE_STATUSES.has(w.status)) ?? [],
    [detail]
  );

  const includedForRun = useMemo(
    () => requeueableWorkflows.filter((w) => !skippedForRun.has(w.workflowId)),
    [requeueableWorkflows, skippedForRun]
  );

  const runBatch = async () => {
    if (!selectedId || includedForRun.length === 0) return;
    setQueueing(true);
    setError(null);
    void loadDetail(selectedId, true, true);
    try {
      await api.queueBatch(selectedId, {
        workflowIds: includedForRun.map((w) => w.workflowId),
      });
      await loadDetail(selectedId, true, true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setQueueing(false);
    }
  };

  const toggleRunInclusion = (workflow: BatchWorkflow) => {
    if (!REQUEUEABLE_STATUSES.has(workflow.status)) return;
    setSkippedForRun((prev) => {
      const next = new Set(prev);
      if (next.has(workflow.workflowId)) next.delete(workflow.workflowId);
      else next.add(workflow.workflowId);
      return next;
    });
  };

  const includeAllForRun = () => {
    setSkippedForRun(new Set());
    setQueueableOnlyView(false);
  };

  const skipPreflightBlocked = () => {
    if (!preflight) return;
    const blockedIds = preflight.items.filter((i) => !i.queueable).map((i) => i.workflowId);
    setSkippedForRun((prev) => {
      const next = new Set(prev);
      blockedIds.forEach((id) => next.add(id));
      return next;
    });
    setQueueableOnlyView(true);
  };

  const removeWorkflowFromBatch = async (workflow: BatchWorkflow) => {
    if (!selectedId || workflow.status !== 'pending') return;
    setRemovingId(workflow.workflowId);
    setError(null);
    try {
      await api.removeBatchWorkflows(selectedId, [workflow.workflowId]);
      setSkippedForRun((prev) => {
        const next = new Set(prev);
        next.delete(workflow.workflowId);
        return next;
      });
      await loadDetail(selectedId, true, true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRemovingId(null);
    }
  };

  const handleRecheckOne = async (workflowId: string, category: string) => {
    setRecheckingId(workflowId);
    setError(null);
    try {
      const result = await recheckWorkflow(workflowId, category);
      if (preflight) {
        setPreflight((prev) => (prev ? applyRecheckToPreflight(prev, result) : prev));
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRecheckingId(null);
    }
  };

  const handleRecheckAllStale = async () => {
    if (!preflight) return;
    setRecheckingAll(true);
    setError(null);
    try {
      const staleItems = preflight.items.filter((i) => isRecheckableCategory(i.category));
      const results = await recheckByCategory(
        staleItems.map((i) => ({ workflowId: i.workflowId, category: i.category }))
      );
      setPreflight((prev) => {
        if (!prev) return prev;
        return results.reduce((acc, result) => applyRecheckToPreflight(acc, result), prev);
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRecheckingAll(false);
    }
  };

  const queueableWorkflowIds = useMemo(() => {
    if (!preflight) return null;
    return new Set(preflight.items.filter((i) => i.queueable).map((i) => i.workflowId));
  }, [preflight]);

  const filteredWorkflows = useMemo(() => {
    if (!detail) return [];
    let rows: BatchWorkflow[];
    switch (filter) {
      case 'failed':
        rows = detail.workflows.filter((w) => w.status === 'failed' || w.status === 'failed-runtime');
        break;
      case 'genuine':
        rows = detail.workflows.filter((w) => w.errorCategory === 'genuine_workflow_error');
        break;
      case 'baseline':
        rows = detail.workflows.filter((w) => BASELINE_CATEGORIES.includes(w.errorCategory));
        break;
      case 'noise':
        rows = detail.workflows.filter((w) => NOISE_CATEGORIES.includes(w.errorCategory));
        break;
      case 'passed':
        rows = detail.workflows.filter((w) => w.errorCategory === 'none' && !isActiveStatus(w.status));
        break;
      default:
        rows = detail.workflows;
    }
    if (queueableOnlyView && queueableWorkflowIds) {
      rows = rows.filter((w) => queueableWorkflowIds.has(w.workflowId));
    }
    return rows;
  }, [detail, filter, queueableOnlyView, queueableWorkflowIds]);

  const genuineCount = detail?.workflows.filter((w) => w.errorCategory === 'genuine_workflow_error').length ?? 0;
  const baselineCount =
    detail?.workflows.filter((w) => BASELINE_CATEGORIES.includes(w.errorCategory)).length ?? 0;
  const noiseCount = detail?.workflows.filter((w) => NOISE_CATEGORIES.includes(w.errorCategory)).length ?? 0;

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-slate-800 px-6 py-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">SWAT</h1>
          <p className="text-xs text-slate-500">Workflow regression testing</p>
        </div>
        <div className="flex items-center gap-3">
          {email && <span className="text-xs text-slate-400">{email}</span>}
          <button
            onClick={() => setShowNewBatch(true)}
            className="rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500"
          >
            New batch
          </button>
        </div>
      </header>

      {error && (
        <div className="border-b border-red-500/30 bg-red-500/10 px-6 py-2 text-sm text-red-300">
          {error}
          <button onClick={() => setError(null)} className="ml-3 underline">
            dismiss
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-80 flex-col border-r border-slate-800">
          <div className="border-b border-slate-800 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-400">
            Batch history
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-2">
            {batches.map((batch) => (
              <button
                key={batch.id}
                onClick={() => setSelectedId(batch.id)}
                className={`mb-1 flex w-full flex-col gap-1 rounded-md border px-3 py-2 text-left transition ${
                  selectedId === batch.id
                    ? 'border-indigo-500/60 bg-indigo-500/10'
                    : 'border-transparent hover:border-slate-800 hover:bg-slate-800/40'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm text-slate-100">{batch.name}</span>
                  <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] ${statusColor(batch.status)}`}>
                    {statusLabel(batch.status)}
                  </span>
                </div>
                <div className="flex items-center justify-between text-[11px] text-slate-500">
                  <span>{batch.totalWorkflows} workflows</span>
                  <span>{batch.progress}%</span>
                </div>
              </button>
            ))}

            {batchesHasMore && (
              <button
                onClick={() => loadBatches(batchPage + 1, false)}
                disabled={loadingBatches}
                className="mt-2 w-full rounded-md border border-slate-800 py-2 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-50"
              >
                {loadingBatches ? 'Loading...' : 'Load more'}
              </button>
            )}
            {!loadingBatches && batches.length === 0 && (
              <div className="px-3 py-6 text-center text-sm text-slate-500">No batches yet.</div>
            )}
          </div>
        </aside>

        <main className="min-w-0 flex-1 overflow-auto p-6">
          {!selectedId && (
            <div className="flex h-full items-center justify-center text-sm text-slate-500">
              Select a batch from the left, or create a new one.
            </div>
          )}

          {selectedId && loadingDetail && !detail && (
            <div className="flex h-full items-center justify-center text-sm text-slate-400">Loading batch...</div>
          )}

          {detail && (
            <div>
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-xl font-semibold text-slate-100">{detail.name}</h2>
                    {liveSyncing && (
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-blue-500/40 bg-blue-500/10 px-2 py-0.5 text-xs font-medium text-blue-300">
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-400" />
                        Live
                      </span>
                    )}
                    <span
                      className={`rounded-full border px-2 py-0.5 text-xs font-medium ${statusColor(detail.status)}`}
                    >
                      {statusLabel(detail.status)}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500">
                    Created {formatDate(detail.createdAt)} • {detail.sequence || 'no sequence'}
                    {detail.progress > 0 && detail.progress < 100 ? ` • ${detail.progress}%` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={runPreflight}
                    disabled={preflightLoading}
                    className="rounded-md border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50"
                  >
                    {preflightLoading ? 'Checking...' : 'Preflight'}
                  </button>
                  <button
                    onClick={() => loadDetail(detail.id, false, true)}
                    className="rounded-md border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800"
                  >
                    Refresh
                  </button>
                  <button
                    onClick={runBatch}
                    disabled={queueing || includedForRun.length === 0}
                    className="rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                    title={
                      includedForRun.length === 0
                        ? 'No workflows selected to run'
                        : skippedForRun.size > 0
                          ? `${skippedForRun.size} workflow(s) skipped for this run`
                          : undefined
                    }
                  >
                    {queueing
                      ? 'Queueing...'
                      : skippedForRun.size > 0
                        ? `Run batch (${includedForRun.length}/${requeueableWorkflows.length})`
                        : `Run batch (${includedForRun.length})`}
                  </button>
                </div>
              </div>

              <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
                <Stat label="Total" value={detail.totalWorkflows} />
                <Stat label="Passed" value={detail.completedWorkflows} tone="emerald" />
                <Stat label="Genuine errors" value={genuineCount} tone="red" />
                <Stat label="Needs baseline" value={baselineCount} tone="violet" />
                <Stat label="SWAT/infra noise" value={noiseCount} tone="orange" />
              </div>

              {preflight && (
                <div className="mb-4 rounded-lg border border-slate-800 bg-slate-900/60 p-4 text-sm">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div className="font-semibold text-slate-200">
                      Preflight: {preflight.queueable} queueable, {preflight.blocked} blocked
                      {preflightCheckedAt ? (
                        <span className="ml-2 text-xs font-normal text-slate-500">
                          (checked {formatDate(new Date(preflightCheckedAt).toISOString())})
                        </span>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setShowPreflightModal(true)}
                        className="rounded-md border border-indigo-500/40 px-2.5 py-1 text-xs text-indigo-200 hover:bg-indigo-500/10"
                      >
                        View full report
                      </button>
                      {preflight.blocked > 0 && (
                        <button
                          onClick={handleRecheckAllStale}
                          disabled={recheckingAll}
                          className="rounded-md border border-violet-500/40 px-2 py-1 text-xs text-violet-200 hover:bg-violet-500/10 disabled:opacity-50"
                        >
                          {recheckingAll ? '⟳ Re-checking all stale...' : '↻ Re-check All Stale'}
                        </button>
                      )}
                    </div>
                  </div>
                  {preflight.blocked > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {Object.entries(
                        preflight.items
                          .filter((i) => !i.queueable)
                          .reduce<Record<string, number>>((acc, i) => {
                            acc[i.category] = (acc[i.category] || 0) + 1;
                            return acc;
                          }, {})
                      )
                        .sort((a, b) => b[1] - a[1])
                        .map(([category, count]) => (
                          <span
                            key={category}
                            className={`rounded-full border px-2 py-0.5 text-[11px] ${categoryColor(category as ErrorCategory)}`}
                          >
                            {CATEGORY_LABEL[category as ErrorCategory]} · {count}
                          </span>
                        ))}
                    </div>
                  )}
                  {preflight.blocked > 8 && (
                    <p className="mt-2 text-xs text-slate-500">
                      {preflight.blocked} blocked workflows — open{' '}
                      <button
                        type="button"
                        onClick={() => setShowPreflightModal(true)}
                        className="text-indigo-300 underline hover:text-indigo-200"
                      >
                        full report
                      </button>{' '}
                      to see all with search & filters.
                    </p>
                  )}
                </div>
              )}

              <div className="mb-3 flex flex-wrap gap-2">
                {(['all', 'genuine', 'baseline', 'noise', 'failed', 'passed'] as WorkflowFilter[]).map((f) => (
                  <button
                    key={f}
                    onClick={() => setFilter(f)}
                    className={`rounded-full border px-3 py-1 text-xs ${
                      filter === f
                        ? 'border-indigo-500/60 bg-indigo-500/10 text-indigo-200'
                        : 'border-slate-700 text-slate-400 hover:bg-slate-800'
                    }`}
                  >
                    {f === 'all' && 'All'}
                    {f === 'genuine' && 'Genuine errors'}
                    {f === 'baseline' && 'Needs baseline'}
                    {f === 'noise' && 'SWAT/infra noise'}
                    {f === 'failed' && 'All failed'}
                    {f === 'passed' && 'Passed'}
                  </button>
                ))}
              </div>

              {requeueableWorkflows.length > 0 && (
                <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2">
                  <span className="text-xs font-medium text-slate-400">Before run:</span>
                  <button
                    type="button"
                    onClick={includeAllForRun}
                    disabled={skippedForRun.size === 0 && !queueableOnlyView}
                    className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-50"
                  >
                    {queueableOnlyView
                      ? 'Show all in batch'
                      : `Include all (${requeueableWorkflows.length})`}
                  </button>
                  {preflight && preflight.blocked > 0 && !queueableOnlyView && (
                    <button
                      type="button"
                      onClick={skipPreflightBlocked}
                      className="rounded-md border border-amber-500/40 px-2 py-1 text-xs text-amber-200 hover:bg-amber-500/10"
                    >
                      Skip preflight blocked ({preflight.blocked})
                    </button>
                  )}
                  {queueableOnlyView && preflight && (
                    <span className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-xs text-emerald-200">
                      Showing queueable only ({preflight.queueable})
                    </span>
                  )}
                  <span className="text-xs text-slate-500">
                    Uncheck <strong className="text-slate-400">Run</strong> to skip this run, or click{' '}
                    <strong className="text-slate-400">Remove</strong> to drop from the batch.
                  </span>
                </div>
              )}

              <WorkflowTable
                workflows={filteredWorkflows}
                onViewDetails={setDetailWorkflow}
                runSelection={{
                  skippedIds: skippedForRun,
                  onToggleRun: toggleRunInclusion,
                  canSelectForRun: (w) => REQUEUEABLE_STATUSES.has(w.status),
                  onRemove: removeWorkflowFromBatch,
                  canRemove: (w) => w.status === 'pending',
                  removingId,
                }}
              />
            </div>
          )}
        </main>
      </div>

      {detailWorkflow && (
        <RunDetailsModal workflow={detailWorkflow} onClose={() => setDetailWorkflow(null)} />
      )}
      {showNewBatch && (
        <NewBatchModal
          onClose={() => setShowNewBatch(false)}
          onCreated={(batchId) => {
            setShowNewBatch(false);
            loadBatches(1, true);
            setSelectedId(batchId);
          }}
        />
      )}
      {showPreflightModal && preflight && (
        <PreflightModal
          key={`${preflight.queueable}-${preflight.blocked}-${preflightCheckedAt ?? 0}`}
          preflight={preflight}
          onClose={() => setShowPreflightModal(false)}
          onRecheckOne={handleRecheckOne}
          onRecheckAllStale={handleRecheckAllStale}
          onSkipBlocked={skipPreflightBlocked}
          recheckingId={recheckingId}
          recheckingAll={recheckingAll}
        />
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone = 'slate',
}: {
  label: string;
  value: number;
  tone?: 'slate' | 'emerald' | 'red' | 'orange' | 'violet';
}) {
  const toneClass =
    tone === 'emerald'
      ? 'text-emerald-300'
      : tone === 'red'
        ? 'text-red-300'
        : tone === 'orange'
          ? 'text-orange-300'
          : tone === 'violet'
            ? 'text-violet-300'
            : 'text-slate-200';
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 px-4 py-3">
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${toneClass}`}>{value}</div>
    </div>
  );
}

function summaryFromDetail(detail: BatchDetail): Partial<BatchSummary> {
  return {
    status: detail.status,
    progress: detail.progress,
    totalWorkflows: detail.totalWorkflows,
    completedWorkflows: detail.completedWorkflows,
    failedWorkflows: detail.failedWorkflows,
  };
}
