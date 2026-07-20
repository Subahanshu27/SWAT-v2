'use client';

import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { BatchWorkflow } from '@/types';
import { CATEGORY_LABEL, categoryColor, formatDuration, isActiveStatus, statusColor, statusLabel } from './format';

export interface RunSelectionProps {
  skippedIds: Set<string>;
  onToggleRun: (workflow: BatchWorkflow) => void;
  canSelectForRun: (workflow: BatchWorkflow) => boolean;
  onRemove?: (workflow: BatchWorkflow) => void;
  canRemove?: (workflow: BatchWorkflow) => boolean;
  removingId?: string | null;
}

interface WorkflowTableProps {
  workflows: BatchWorkflow[];
  onViewDetails: (workflow: BatchWorkflow) => void;
  runSelection?: RunSelectionProps;
}

const ROW_HEIGHT = 56;

const GRID_WITH_RUN =
  'grid-cols-[48px_minmax(0,1fr)_minmax(100px,130px)_minmax(120px,1fr)_72px_minmax(148px,auto)]';
const GRID_DEFAULT = 'grid-cols-[minmax(0,1fr)_minmax(100px,130px)_minmax(120px,1fr)_72px_minmax(120px,auto)]';
const GRID_GAP = 'gap-x-5';

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

export function WorkflowTable({ workflows, onViewDetails, runSelection }: WorkflowTableProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const hasRunColumn = Boolean(runSelection);

  const virtualizer = useVirtualizer({
    count: workflows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  if (workflows.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-slate-500">
        No workflows in this batch.
      </div>
    );
  }

  const gridCols = hasRunColumn ? GRID_WITH_RUN : GRID_DEFAULT;

  return (
    <div className="overflow-hidden rounded-lg border border-slate-800">
      <div
        className={`grid ${gridCols} ${GRID_GAP} border-b border-slate-800 bg-slate-900/60 px-5 py-3 text-xs font-semibold uppercase tracking-wide text-slate-400`}
      >
        {hasRunColumn && <div className="flex items-center" title="Include when you click Run batch">Run</div>}
        <div className="min-w-0">Workflow</div>
        <div>Status</div>
        <div className="min-w-0">Classification</div>
        <div className="text-right">Runtime</div>
        <div className="border-l border-slate-800/80 pl-5 text-right">Action</div>
      </div>

      <div ref={parentRef} className="max-h-[55vh] overflow-auto">
        <div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative', width: '100%' }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const wf = workflows[virtualRow.index];
            const errorMessage = displayText(wf.errorMessage);
            const canRun = runSelection?.canSelectForRun(wf) ?? false;
            const skipped = runSelection?.skippedIds.has(wf.workflowId) ?? false;
            const included = canRun && !skipped;
            const canRemove = runSelection?.canRemove?.(wf) ?? false;

            return (
              <div
                key={wf.id}
                className={`absolute left-0 top-0 grid w-full ${gridCols} ${GRID_GAP} items-center border-b border-slate-800/60 px-5 text-sm ${
                  skipped && canRun ? 'bg-slate-950/40 opacity-70' : 'hover:bg-slate-900/30'
                }`}
                style={{ height: `${ROW_HEIGHT}px`, transform: `translateY(${virtualRow.start}px)` }}
              >
                {hasRunColumn && (
                  <div className="flex items-center">
                    {canRun ? (
                      <input
                        type="checkbox"
                        checked={included}
                        onChange={() => runSelection?.onToggleRun(wf)}
                        title={included ? 'Will run on Run batch' : 'Skipped for this run'}
                        className="cursor-pointer"
                      />
                    ) : (
                      <span className="text-[10px] text-slate-600">—</span>
                    )}
                  </div>
                )}

                <div className="min-w-0">
                  <div className="truncate text-slate-100" title={wf.name}>
                    {wf.name}
                  </div>
                  <div className="flex items-center gap-2 text-[11px] text-slate-500">
                    {wf.verified ? (
                      <span className="text-emerald-400">verified</span>
                    ) : (
                      <span className="text-slate-500">unverified</span>
                    )}
                    {skipped && canRun && <span className="text-amber-400">skipped for run</span>}
                  </div>
                </div>

                <div>
                  <span
                    className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${statusColor(wf.status)}`}
                  >
                    {isActiveStatus(wf.status) && (
                      <span className="h-2 w-2 animate-pulse rounded-full bg-current" />
                    )}
                    {statusLabel(wf.status)}
                  </span>
                </div>

                <div className="min-w-0 pr-2">
                  {wf.errorCategory !== 'none' ? (
                    <span
                      className={`inline-flex max-w-full items-center truncate rounded-full border px-2 py-0.5 text-[11px] ${categoryColor(wf.errorCategory)}`}
                      title={errorMessage}
                    >
                      {CATEGORY_LABEL[wf.errorCategory]}
                    </span>
                  ) : (
                    <span className="text-slate-600">—</span>
                  )}
                </div>

                <div className="text-right tabular-nums text-slate-400">
                  {formatDuration(wf.durationSeconds) ?? '—'}
                </div>

                <div className="flex items-center justify-end gap-2 border-l border-slate-800/80 pl-5">
                  {canRemove && runSelection?.onRemove && (
                    <button
                      onClick={() => runSelection.onRemove?.(wf)}
                      disabled={runSelection.removingId === wf.workflowId}
                      className="min-w-[4.5rem] rounded-md border border-red-500/30 px-2.5 py-1 text-xs text-red-300 hover:bg-red-500/10 disabled:opacity-50"
                    >
                      {runSelection.removingId === wf.workflowId ? '…' : 'Remove'}
                    </button>
                  )}
                  <button
                    onClick={() => onViewDetails(wf)}
                    className="min-w-[4.5rem] rounded-md border border-slate-700 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-800"
                  >
                    View
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
