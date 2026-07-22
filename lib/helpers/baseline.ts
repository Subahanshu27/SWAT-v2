import type { ErrorCategory, PromptBaseline } from '@/types';

/** Block queueing when baseline is missing, stale, outdated, or community input missing. */
export function shouldBlockForBaseline(baseline: PromptBaseline | undefined): boolean {
  if (!baseline || baseline === 'exact') return false;
  return (
    baseline === 'missing' ||
    baseline === 'stale' ||
    baseline === 'outdated' ||
    baseline === 'community_input_missing'
  );
}

export function baselineBlockCategory(baseline: PromptBaseline): ErrorCategory {
  if (baseline === 'missing') return 'prompt_baseline_missing';
  if (baseline === 'outdated') return 'prompt_baseline_outdated';
  if (baseline === 'community_input_missing') return 'invalid_prompt_files';
  return 'prompt_baseline_stale';
}
