import type { ErrorCategory } from '@/types';

/** Short, operator-facing preflight text (no node IDs / infra dumps in the UI). */
export function preflightReason(category: ErrorCategory): string {
  switch (category) {
    case 'prompt_baseline_missing':
      return 'No trusted baseline found — Run + Publish in the Floyo editor to create one.';
    case 'prompt_baseline_stale':
      return 'Baseline stale — Run + Publish this workflow in the Floyo editor to refresh.';
    case 'prompt_baseline_outdated':
      return 'Baseline outdated (missing infra fields) — Run + Publish in the Floyo editor to refresh.';
    case 'community_input_missing':
      return 'Referenced file not found — re-upload in Floyo editor, then Run + Publish.';
    case 'prompt_generation_failed':
      return 'Could not build a valid prompt — Run + Publish in the Floyo editor, then retry.';
    case 'invalid_workflow_json':
      return 'workflow_json is missing or invalid — fix in the Floyo editor, then Run + Publish.';
    default:
      return 'Run + Publish this workflow in the Floyo editor, then retry in SWAT.';
  }
}
