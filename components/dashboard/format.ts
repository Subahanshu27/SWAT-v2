import { ErrorCategory, WorkflowStatus } from '@/types';

export function statusColor(status: WorkflowStatus | string): string {
  switch (status) {
    case 'running':
      return 'bg-blue-500/15 text-blue-300 border-blue-500/40';
    case 'queued':
      return 'bg-amber-500/15 text-amber-300 border-amber-500/40';
    case 'pending':
      return 'bg-slate-500/15 text-slate-300 border-slate-500/40';
    case 'completed':
    case 'passed':
    case 'passed-exact':
      return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40';
    case 'passed-acceptable':
      return 'bg-teal-500/15 text-teal-300 border-teal-500/40';
    case 'failed':
    case 'failed-runtime':
      return 'bg-red-500/15 text-red-300 border-red-500/40';
    case 'blocked':
      return 'bg-violet-500/15 text-violet-300 border-violet-500/40';
    case 'cancelled':
      return 'bg-slate-600/20 text-slate-400 border-slate-600/40';
    default:
      return 'bg-slate-500/15 text-slate-300 border-slate-500/40';
  }
}

export function statusLabel(status: WorkflowStatus | string): string {
  switch (status) {
    case 'completed':
    case 'passed':
    case 'passed-exact':
      return 'Passed';
    case 'passed-acceptable':
      return 'Passed (approx)';
    case 'failed':
    case 'failed-runtime':
      return 'Failed';
    case 'blocked':
      return 'Needs baseline';
    default:
      return status.charAt(0).toUpperCase() + status.slice(1);
  }
}

export const CATEGORY_LABEL: Record<ErrorCategory, string> = {
  none: 'No error',
  genuine_workflow_error: 'Genuine workflow error',
  invalid_workflow_json: 'Invalid workflow JSON',
  prompt_generation_failed: 'Prompt generation failed',
  prompt_baseline_missing: 'Needs baseline',
  prompt_baseline_stale: 'Stale baseline',
  prompt_baseline_outdated: 'Outdated baseline',
  community_input_missing: 'Missing community file',
  infra_error: 'SWAT / infra error',
};

export function categoryColor(category: ErrorCategory): string {
  switch (category) {
    case 'genuine_workflow_error':
      return 'bg-red-500/15 text-red-300 border-red-500/40';
    case 'invalid_workflow_json':
    case 'prompt_generation_failed':
      return 'bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/40';
    case 'prompt_baseline_missing':
    case 'prompt_baseline_stale':
    case 'prompt_baseline_outdated':
    case 'community_input_missing':
      return 'bg-violet-500/15 text-violet-300 border-violet-500/40';
    case 'infra_error':
      return 'bg-orange-500/15 text-orange-300 border-orange-500/40';
    default:
      return 'bg-slate-500/15 text-slate-300 border-slate-500/40';
  }
}

export function formatDuration(seconds?: number): string {
  if (seconds === undefined || seconds === null) return '-';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

export function formatDate(value?: string): string {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString();
}

export function isActiveStatus(status: WorkflowStatus | string): boolean {
  return status === 'pending' || status === 'queued' || status === 'running';
}
