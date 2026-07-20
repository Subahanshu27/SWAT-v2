import type { ErrorCategory, PromptBaseline } from '@/types';

const ALWAYS_BLOCKED: PromptBaseline[] = ['stale', 'outdated', 'community_input_missing'];

/** When true, workflows with missing baseline may queue (stale/outdated still blocked). */
export function shouldBlockForBaseline(
  baseline: PromptBaseline | undefined,
  queueUnverifiedMissing: boolean
): boolean {
  if (!baseline || baseline === 'exact') return false;
  if (baseline === 'missing') return !queueUnverifiedMissing;
  return ALWAYS_BLOCKED.includes(baseline);
}

export function baselineBlockCategory(baseline: PromptBaseline): ErrorCategory {
  if (baseline === 'missing') return 'prompt_baseline_missing';
  if (baseline === 'outdated') return 'prompt_baseline_outdated';
  if (baseline === 'community_input_missing') return 'community_input_missing';
  return 'prompt_baseline_stale';
}
