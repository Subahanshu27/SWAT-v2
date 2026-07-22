export type ErrorActionSeverity = 'retry' | 'fix' | 'escalate' | 'skip';

export interface ErrorAction {
  action: string;
  severity: ErrorActionSeverity;
}

export const ERROR_BUCKET_ACTIONS: Record<string, ErrorAction> = {
  cold_start_timeout: {
    action: 'Retry — pod was likely spinning up. Use the Re-check button.',
    severity: 'retry',
  },
  dispatcher_5xx: {
    action: 'Transient server error. Retry in a few minutes.',
    severity: 'retry',
  },
  dispatcher_timeout: {
    action: 'Dispatcher timed out. Likely cold start or heavy load. Retry.',
    severity: 'retry',
  },
  infra_auth: {
    action:
      'Dispatcher auth failed — check DISPATCHER_BACKEND_TOKEN, DISPATCHER_TEAM_ID, and DISPATCHER_USER_ID in .env.',
    severity: 'fix',
  },
  infra_unknown: {
    action: 'Unrecognized SWAT/dispatcher infra error — check raw error in Run Details.',
    severity: 'escalate',
  },
  community_input_missing: {
    action: 'File missing from storage — re-upload in Floyo (#inputs or #community_inputs), then Run + Publish.',
    severity: 'fix',
  },
  invalid_prompt_files: {
    action:
      'Prompt references files not in storage metadata. Fix #inputs / #community_inputs in Floyo editor, then Run + Publish.',
    severity: 'fix',
  },
  missing_files: {
    action: 'Referenced input file missing from storage. Re-upload or update paths, then Run + Publish.',
    severity: 'fix',
  },
  stale_baseline: {
    action: 'Run + Publish this workflow in the Floyo editor to refresh baseline.',
    severity: 'fix',
  },
  outdated_baseline: {
    action: 'Baseline missing new infra fields. Run + Publish in the Floyo editor.',
    severity: 'fix',
  },
  codec_gap: {
    action: 'Known infra bug on comfyui-gpu-9100. Skip or escalate to Jon.',
    severity: 'escalate',
  },
  shape_mismatch: {
    action: 'Known Nano Banana 2 shape mismatch bug. Check if NB provider is back up.',
    severity: 'escalate',
  },
  stale_endpoint: {
    action: 'Seedance lite endpoint rotated. Escalate to Jon.',
    severity: 'escalate',
  },
  errno_21_directory: {
    action: 'Known bug: [Errno 21] is a directory. Escalate to Jon.',
    severity: 'escalate',
  },
  torchcodec_missing: {
    action: 'Missing torchcodec dependency on pod. Escalate to Jon.',
    severity: 'escalate',
  },
  nb_provider_outage: {
    action: 'Nano Banana provider is down. Wait for provider recovery or skip.',
    severity: 'skip',
  },
  unknown: {
    action: 'Check raw error in Run Details. May need manual investigation.',
    severity: 'escalate',
  },
};

export function getErrorAction(bucket: string): ErrorAction {
  return ERROR_BUCKET_ACTIONS[bucket] || ERROR_BUCKET_ACTIONS.unknown;
}
