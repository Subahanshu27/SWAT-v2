import 'server-only';
import { env } from '@/lib/config/env';
import type { PromptBaseline } from '@/types';

export type PromptSource = 'service' | 'stored' | 'none';

export interface ResolvedPrompt {
  prompt: Record<string, unknown> | null;
  source: PromptSource;
  reason?: string;
  strategy?: string;
  /**
   * Whether the resolved prompt is the exact output of a successful UI run whose
   * graph still matches the current workflow. Only trusted prompts should be
   * treated as a real regression test; others need a baseline established first.
   */
  baseline?: PromptBaseline;
  trusted?: boolean;
}

/**
 * A Comfy API prompt is an object map of nodeId -> { class_type, inputs }.
 */
export function isApiPromptShape(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return false;

  return entries.every(([, node]) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
    const n = node as Record<string, unknown>;
    return typeof n.class_type === 'string' && typeof n.inputs === 'object' && n.inputs !== null;
  });
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export interface ResolvePromptOptions {
  workflowId?: string;
  workflowJson?: unknown;
  storedPrompt?: unknown;
  /**
   * Preflight / baseline trust check only — ask prompt-service using workflow_id.
   * Avoids sending heavy workflow_json (fixes false "Needs baseline" under load).
   */
  baselineCheckOnly?: boolean;
}

/**
 * Resolve a valid API prompt for a workflow.
 *
 * When FLOYO_PROMPT_SERVICE_URL is set, SWAT2 calls the local prompt service
 * which builds the prompt in memory (and may READ a past successful run prompt).
 * It never writes to the database.
 */
export async function resolvePrompt(
  workflowJsonOrOptions: unknown,
  storedPrompt?: unknown,
  workflowId?: string
): Promise<ResolvedPrompt> {
  // Support both resolvePrompt(json, prompt, id) and resolvePrompt({ ... }).
  const opts: ResolvePromptOptions =
    workflowJsonOrOptions &&
    typeof workflowJsonOrOptions === 'object' &&
    'workflowJson' in (workflowJsonOrOptions as object)
      ? (workflowJsonOrOptions as ResolvePromptOptions)
      : {
          workflowJson: workflowJsonOrOptions,
          storedPrompt,
          workflowId,
        };

  const parsedWorkflowJson = parseMaybeJson(opts.workflowJson);
  const parsedStoredPrompt = parseMaybeJson(opts.storedPrompt);

  if (env.promptService.url) {
    try {
      const baselineOnly = opts.baselineCheckOnly && !!opts.workflowId;
      const res = await fetch(env.promptService.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          baselineOnly
            ? { workflow_id: opts.workflowId }
            : {
                workflow_id: opts.workflowId,
                workflow_json: parsedWorkflowJson,
                prompt: parsedStoredPrompt,
              }
        ),
      });

      const json = (await res.json()) as {
        success?: boolean;
        prompt?: unknown;
        reason?: string;
        strategy?: string;
        source?: string;
        baseline?: PromptBaseline;
        trusted?: boolean;
        category?: string;
      };

      if (res.ok && json?.success && isApiPromptShape(json.prompt)) {
        let baseline = json.baseline;
        if (
          json.category === 'community_input_missing' ||
          json.category === 'invalid_prompt_files'
        ) {
          baseline = 'community_input_missing';
        }
        return {
          prompt: json.prompt as Record<string, unknown>,
          source: 'service',
          strategy: json.strategy,
          reason: json.reason,
          baseline,
          trusted: json.trusted ?? json.baseline === 'exact',
        };
      }

      return {
        prompt: null,
        source: 'none',
        reason:
          json?.reason ||
          (json?.success === false ? 'Prompt service could not build a valid prompt' : `HTTP ${res.status}`),
        strategy: json?.strategy,
        baseline: json?.baseline,
        trusted: false,
      };
    } catch (err) {
      return {
        prompt: null,
        source: 'none',
        reason: `Prompt service unreachable: ${(err as Error).message}`,
      };
    }
  }

  const stored = parsedStoredPrompt;
  if (isApiPromptShape(stored)) {
    return { prompt: stored as Record<string, unknown>, source: 'stored' };
  }

  return {
    prompt: null,
    source: 'none',
    reason:
      'No valid API prompt available. Start the prompt service and set FLOYO_PROMPT_SERVICE_URL in SWAT2/.env',
  };
}
