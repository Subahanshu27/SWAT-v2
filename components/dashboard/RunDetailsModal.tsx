'use client';

import { useEffect, useState } from 'react';
import { BatchWorkflow } from '@/types';
import { WorkflowRunDetails } from '@/lib/services/workflow-run.service';
import { deriveErrorBucket } from '@/lib/helpers/status';
import { getErrorAction } from '@/lib/config/error-actions';
import { api } from './api';
import { CATEGORY_LABEL, categoryColor, formatDate, formatDuration, statusColor, statusLabel } from './format';

const SEVERITY_CLASS: Record<string, string> = {
  retry: 'bg-amber-500/20 text-amber-200 border-amber-500/40',
  fix: 'bg-emerald-500/20 text-emerald-200 border-emerald-500/40',
  escalate: 'bg-red-500/20 text-red-200 border-red-500/40',
  skip: 'bg-slate-500/20 text-slate-300 border-slate-500/40',
};

interface RunDetailsModalProps {
  workflow: BatchWorkflow;
  onClose: () => void;
}

function Field({ label, value, mono }: { label: string; value?: string; mono?: boolean }) {
  return (
    <div>
      <div className="mb-1 text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`break-all text-slate-200 ${mono ? 'font-mono text-xs' : 'text-sm'}`}>
        {value || '-'}
      </div>
    </div>
  );
}

function displayText(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object' && 'message' in value) {
    const message = displayText((value as { message?: unknown }).message);
    if (message) return message;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function RunDetailsModal({ workflow, onClose }: RunDetailsModalProps) {
  const [details, setDetails] = useState<WorkflowRunDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    let active = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    api
      .runDetails(workflow.id)
      .then((data) => {
        if (active) setDetails(data);
      })
      .catch((err) => {
        if (active) setError((err as Error).message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [workflow.id]);

  const d = details;
  const category = d?.errorCategory ?? workflow.errorCategory;
  const errorMessage = displayText(d?.errorMessage ?? workflow.errorMessage);
  const errorDetails =
    d?.errorDetails && typeof d.errorDetails === 'object'
      ? (d.errorDetails as Record<string, unknown>)
      : undefined;
  const errorBucket = deriveErrorBucket(category, errorMessage, errorDetails);
  const errorInfo = getErrorAction(errorBucket);
  const dispatchAttempts = Number(errorDetails?.dispatch_attempts ?? 0);
  const retriedFrom = displayText(errorDetails?.retried_from);
  const isBaseline =
    category === 'prompt_baseline_missing' ||
    category === 'prompt_baseline_stale' ||
    category === 'prompt_baseline_outdated' ||
    category === 'community_input_missing';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="max-h-[88vh] w-full max-w-3xl overflow-auto rounded-xl border border-slate-800 bg-slate-900 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="truncate text-lg font-semibold text-slate-100">{workflow.name}</h3>
            <p className="mt-1 break-all font-mono text-xs text-slate-400">
              Run ID: {d?.runId || workflow.runId || 'N/A'}
            </p>
          </div>
          <button onClick={onClose} className="rounded-md border border-slate-700 px-3 py-1 text-sm text-slate-300 hover:bg-slate-800">
            Close
          </button>
        </div>

        <div className="mb-5 flex flex-wrap items-center gap-2">
          <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs ${statusColor(workflow.status)}`}>
            {statusLabel(workflow.status)}
          </span>
          <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs ${categoryColor(category)}`}>
            {CATEGORY_LABEL[category]}
          </span>
        </div>

        {loading && <div className="py-8 text-center text-sm text-slate-400">Loading run details...</div>}
        {error && <div className="py-4 text-sm text-red-400">{error}</div>}

        {!loading && (
          <>
            {errorMessage && (
              <div
                className={`mb-5 rounded-lg border p-4 ${
                  isBaseline ? 'border-violet-500/30 bg-violet-500/5' : 'border-red-500/30 bg-red-500/5'
                }`}
              >
                <div
                  className={`mb-1 text-xs font-semibold uppercase tracking-wide ${
                    isBaseline ? 'text-violet-300' : 'text-red-300'
                  }`}
                >
                  {isBaseline ? 'What to do' : 'Error message'}
                </div>
                <div className={`break-words text-sm ${isBaseline ? 'text-violet-100' : 'text-red-200'}`}>
                  {errorMessage}
                </div>
              </div>
            )}

            {category !== 'none' && (
              <div className="mb-5 rounded-lg border border-slate-700 bg-slate-950/40 p-4">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                    Recommended action
                  </span>
                  <span
                    className={`rounded border px-2 py-0.5 text-[11px] font-semibold uppercase ${SEVERITY_CLASS[errorInfo.severity] || SEVERITY_CLASS.escalate}`}
                  >
                    {errorInfo.severity}
                  </span>
                  <span className="text-[11px] text-slate-500">bucket: {errorBucket}</span>
                </div>
                <p className="text-sm text-slate-200">{errorInfo.action}</p>
              </div>
            )}

            {dispatchAttempts > 1 && (
              <div className="mb-5 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-100">
                Passed on retry (attempt {dispatchAttempts}
                {retriedFrom ? ` — first attempt: ${retriedFrom}` : ''})
              </div>
            )}

            <div className="mb-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Runtime" value={formatDuration(d?.executionTimeSeconds ?? d?.durationSeconds)} />
              <Field label="Time in queue" value={formatDuration(d?.timeInQueueSeconds)} />
              <Field label="Started" value={formatDate(d?.startedAt)} />
              <Field label="Finished" value={formatDate(d?.completedAt)} />
              <Field label="Batch workflow ID" value={d?.batchWorkflowId || workflow.id} mono />
              <Field label="Run ID" value={d?.runId || workflow.runId} mono />
              <Field label="Actual hash" value={d?.actualImageHash || workflow.actualImageHash} mono />
              <Field label="Golden hash" value={d?.goldenImageHash} mono />
              <Field label="Golden run ID" value={d?.goldenRunId} mono />
            </div>

            {d?.errorDetails != null && (
              <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-4">
                <button
                  onClick={() => setShowRaw((v) => !v)}
                  className="text-xs font-semibold uppercase tracking-wide text-slate-400 hover:text-slate-200"
                >
                  {showRaw ? 'Hide' : 'Show'} raw error details
                </button>
                {showRaw && (
                  <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-all text-xs text-slate-300">
                    {JSON.stringify(d.errorDetails, null, 2)}
                  </pre>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
