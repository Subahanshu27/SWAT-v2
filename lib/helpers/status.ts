import { BatchStatus, ErrorCategory, WorkflowStatus } from '@/types';

export const SUCCESS_STATUSES = new Set<WorkflowStatus>([
  'completed',
  'passed',
  'passed-exact',
  'passed-acceptable',
]);

export const FAILURE_STATUSES = new Set<WorkflowStatus>(['failed', 'failed-runtime']);

/**
 * Terminal-but-not-a-failure: the workflow could not be tested because it has no
 * trusted, current prompt baseline. These are NOT regressions — they need a
 * successful run in the Floyo UI to establish/refresh their baseline.
 */
export const BLOCKED_STATUSES = new Set<WorkflowStatus>(['blocked']);

export const TERMINAL_STATUSES = new Set<WorkflowStatus>([
  ...SUCCESS_STATUSES,
  ...FAILURE_STATUSES,
  ...BLOCKED_STATUSES,
  'cancelled',
]);

export const ACTIVE_STATUSES = new Set<WorkflowStatus>(['pending', 'queued', 'running']);

/** Workflows in these states can be sent again when the batch is re-run. */
export const REQUEUEABLE_STATUSES = new Set<WorkflowStatus>([
  'pending',
  'failed',
  'failed-runtime',
  'blocked',
  'cancelled',
]);

/**
 * Error categories that mean "SWAT couldn't test this yet", as opposed to a
 * genuine workflow failure. Used to keep the "Needs baseline" bucket separate.
 */
export const BASELINE_CATEGORIES = new Set<ErrorCategory>([
  'prompt_baseline_missing',
  'prompt_baseline_stale',
  'prompt_baseline_outdated',
  'community_input_missing',
]);

export function isTerminal(status: WorkflowStatus | string | null | undefined): boolean {
  return !!status && TERMINAL_STATUSES.has(status as WorkflowStatus);
}

/**
 * Map a dispatcher / workflow_runs status onto a SWAT workflow status.
 */
export function mapRunStatusToWorkflowStatus(runStatus: string): WorkflowStatus | null {
  switch ((runStatus || '').toLowerCase()) {
    case 'queued':
      return 'queued';
    case 'pending':
      return 'pending';
    case 'initializing':
    case 'processing':
    case 'running':
      return 'running';
    case 'done':
    case 'completed':
      return 'passed-exact';
    case 'passed':
      return 'passed';
    case 'passed-exact':
      return 'passed-exact';
    case 'passed-acceptable':
      return 'passed-acceptable';
    case 'failed':
    case 'failed-runtime':
      return 'failed-runtime';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    default:
      return null;
  }
}

/**
 * Derive an overall batch status from its workflows' statuses.
 */
export function deriveBatchStatus(statuses: WorkflowStatus[]): BatchStatus {
  if (statuses.length === 0) return 'pending';
  if (statuses.some((s) => s === 'running')) return 'running';
  if (statuses.some((s) => s === 'queued')) return 'queued';
  if (statuses.some((s) => s === 'pending')) return 'pending';
  if (statuses.some((s) => FAILURE_STATUSES.has(s))) return 'failed';
  if (statuses.some((s) => s === 'cancelled')) return 'cancelled';
  return 'completed';
}

/**
 * Decide whether a failed workflow is a genuine workflow error or SWAT/infra
 * noise, based on the error_details payload we stored at queue time.
 */
export function classifyError(
  status: WorkflowStatus | string,
  errorDetails: unknown
): { category: ErrorCategory; message?: string } {
  if (SUCCESS_STATUSES.has(status as WorkflowStatus)) {
    return { category: 'none' };
  }

  const details = normalizeDetails(errorDetails);
  const message = extractMessage(details);
  const type = (details?.error_type as string) || '';
  const statusCode = Number(details?.status_code ?? details?.response?.status_code ?? NaN);

  // Explicit categorization recorded by SWAT2 at queue/preflight time. This is
  // authoritative for both failures and 'blocked' (needs-baseline) rows.
  const recorded = details?.error_category as ErrorCategory | undefined;
  if (recorded && recorded !== 'none') {
    return { category: recorded, message };
  }

  // Beyond an explicit category, only failed rows get heuristic classification.
  if (!FAILURE_STATUSES.has(status as WorkflowStatus)) {
    return { category: 'none', message };
  }

  if (type === 'ParseError' || /workflow_json/i.test(message || '')) {
    return { category: 'invalid_workflow_json', message };
  }
  if (/prompt/i.test(message || '') && /(invalid|generate|missing)/i.test(message || '')) {
    return { category: 'prompt_generation_failed', message };
  }
  // Auth / network / dispatcher availability => infra, not the workflow.
  if (
    [401, 403, 408, 429, 500, 502, 503, 504].includes(statusCode) ||
    /timeout|network|fetch failed|ECONN|aborted/i.test(message || '')
  ) {
    return { category: 'infra_error', message };
  }

  // Anything else that came back from the dispatcher about the run itself.
  return { category: 'genuine_workflow_error', message };
}

/**
 * Derive a coarse error bucket key from category + message for action hints.
 */
export function deriveErrorBucket(
  category: ErrorCategory,
  message?: string,
  details?: Record<string, unknown>
): string {
  const msg = (message || '').toLowerCase();
  const statusCode = Number(details?.status_code ?? NaN);

  switch (category) {
    case 'prompt_baseline_stale':
      return 'stale_baseline';
    case 'prompt_baseline_outdated':
      return 'outdated_baseline';
    case 'community_input_missing':
      return 'community_input_missing';
    case 'infra_error':
      if (statusCode === 401 || statusCode === 403 || /unauthorized|forbidden|auth/i.test(msg)) {
        return 'infra_auth';
      }
      if (/cold start|spinning up/i.test(msg)) return 'cold_start_timeout';
      if (statusCode >= 500 || /502|503|504/.test(msg)) return 'dispatcher_5xx';
      if (/timeout|timed out|aborted|econn/i.test(msg)) return 'dispatcher_timeout';
      return 'infra_unknown';
    case 'genuine_workflow_error':
      if (/torchcodec/i.test(msg)) return 'torchcodec_missing';
      if (/shape mismatch|nano banana|nanobanana/i.test(msg)) return 'shape_mismatch';
      if (/seedance.*endpoint|stale endpoint/i.test(msg)) return 'stale_endpoint';
      if (/errno 21|is a directory/i.test(msg)) return 'errno_21_directory';
      if (/codec/i.test(msg)) return 'codec_gap';
      if (/nano banana.*provider|nb provider/i.test(msg)) return 'nb_provider_outage';
      return 'unknown';
    default:
      return 'unknown';
  }
}

function normalizeDetails(raw: unknown): Record<string, any> | undefined {
  if (!raw) return undefined;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return { error_message: raw };
    }
  }
  if (typeof raw === 'object') return raw as Record<string, any>;
  return undefined;
}

function extractMessage(details?: Record<string, any>): string | undefined {
  if (!details) return undefined;
  return firstMessage(
    details.error_message,
    details.message,
    details.error?.message,
    details.error,
    details.status_text,
    details.response,
    details.response?.error
  );
}

function firstMessage(...values: unknown[]): string | undefined {
  for (const value of values) {
    const message = stringifyMessage(value);
    if (message) return message;
  }
  return undefined;
}

function stringifyMessage(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value !== 'object') return undefined;

  const objectValue = value as Record<string, unknown>;
  const nestedMessage = stringifyMessage(objectValue.message);
  if (nestedMessage) return nestedMessage;

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
