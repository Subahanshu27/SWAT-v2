// Shared types for SWAT2

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface AuthUser {
  id: string;
  email?: string;
  role?: string;
  teamId?: string | null;
}

export type WorkflowStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'completed'
  | 'passed'
  | 'passed-exact'
  | 'passed-acceptable'
  | 'failed'
  | 'failed-runtime'
  | 'blocked' // Not tested: no trusted/current prompt baseline to run
  | 'cancelled';

export type BatchStatus = WorkflowStatus;

/**
 * How an error/result is categorized so the team only acts on genuine workflow
 * failures, not SWAT infrastructure noise or missing test baselines.
 */
export type ErrorCategory =
  | 'genuine_workflow_error' // The workflow itself failed on the dispatcher/GPU
  | 'invalid_workflow_json' // workflow_json missing or unparseable
  | 'prompt_generation_failed' // Could not build a valid API prompt at all
  | 'prompt_baseline_missing' // No successful UI run to establish an exact prompt
  | 'prompt_baseline_stale' // Workflow changed since its last successful UI run
  | 'prompt_baseline_outdated' // Trusted baseline predates current infra / node schema
  | 'community_input_missing' // Referenced #community_inputs file deleted from storage
  | 'infra_error' // SWAT/dispatcher/network/auth problem, not the workflow
  | 'none'; // No error

/** Result of a prompt-service baseline check for a workflow. */
export type PromptBaseline =
  | 'exact'
  | 'stale'
  | 'outdated'
  | 'missing'
  | 'community_input_missing'
  | 'unknown';

/** Lightweight workflow row used for catalog/search lists. */
export interface WorkflowListItem {
  id: string;
  name: string;
  description?: string;
  image?: string;
  verified: boolean;
  isPrivate: boolean;
  createdAt?: string;
}

/** Counts for active public workflows (matches prod catalog SQL). */
export interface WorkflowCatalogStats {
  verifiedCount: number;
  notVerifiedCount: number;
  totalActive: number;
  includePrivate: boolean;
}

/** A workflow as it appears inside a batch. */
export interface BatchWorkflow {
  id: string; // batch_workflows.id (primary key)
  batchId: string;
  workflowId: string;
  name: string;
  verified: boolean;
  status: WorkflowStatus;
  position?: number;
  priority?: number;
  runId?: string;
  startedAt?: string;
  completedAt?: string;
  durationSeconds?: number;
  timeInQueueSeconds?: number;
  executionTimeSeconds?: number;
  goldenImageHash?: string;
  actualImageHash?: string;
  errorCategory: ErrorCategory;
  errorMessage?: string;
  errorDetails?: unknown;
}

export interface BatchSummary {
  id: string;
  name: string;
  status: BatchStatus;
  sequence?: string;
  startedAt?: string;
  completedAt?: string;
  durationSeconds?: number;
  progress: number;
  totalWorkflows: number;
  completedWorkflows: number;
  failedWorkflows: number;
  createdAt?: string;
}

export interface BatchDetail extends BatchSummary {
  workflows: BatchWorkflow[];
}

export interface PreflightItem {
  workflowId: string;
  name: string;
  queueable: boolean;
  category: ErrorCategory;
  reason?: string;
  promptSource?: 'service' | 'stored' | 'none';
  baseline?: PromptBaseline;
}

export interface PreflightResult {
  total: number;
  queueable: number;
  blocked: number;
  items: PreflightItem[];
}
