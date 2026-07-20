/**
 * READ-ONLY fallback: fetch the latest successful run for a workflow.
 * Does not write anything to the database.
 *
 * SWAT baseline category mirrors prod error-bucket SQL:
 *   - Verified Unchanged input unchanged  → queueable (trusted)
 *   - Verified Unchanged input changed    → stale (inputs drift)
 *   - Verified changed                    → stale (graph/topology drift)
 *   - Unverified                          → stale / missing
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { isApiPromptShape, parseMaybeJson } from './prompt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IGNORE_FIELDS_PATH = path.join(__dirname, '../config/baseline-ignore-fields.json');

let ignoreFieldsConfig;
try {
  ignoreFieldsConfig = JSON.parse(fs.readFileSync(IGNORE_FIELDS_PATH, 'utf8'));
} catch {
  console.warn('[SWAT] baseline-ignore-fields.json not found, using hardcoded defaults');
  ignoreFieldsConfig = {
    _default: ['image', 'seed', 'text', 'noise_seed', 'rand_seed'],
  };
}

let client = null;

function getClient() {
  if (client) return client;
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  client = createClient(url, key, { auth: { persistSession: false } });
  return client;
}

function mapRunRow(data) {
  const prompt = parseMaybeJson(data.prompt);
  if (!isApiPromptShape(prompt)) return null;

  return {
    prompt,
    workflowJson: parseMaybeJson(data.workflow_json) ?? null,
    runId: data.id ?? null,
    createdAt: data.created_at ?? null,
    promptChanged: parseMaybeJson(data.prompt_changed) ?? null,
    basePromptChanged:
      typeof data.base_prompt_changed === 'boolean' ? data.base_prompt_changed : null,
    baseIsVerified:
      typeof data.base_is_verified === 'boolean' ? data.base_is_verified : null,
  };
}

/**
 * Prod marks seed/text/etc. as ignored for equivalence. Trust those runs when graph
 * is stable and no significant inputs changed.
 */
function isIgnorableInputDriftOnly(run, workflowType = null) {
  const pc = run.promptChanged;
  if (!pc || typeof pc !== 'object') return false;

  if (pc.equivalent_to_base === true) return true;

  const flags = pc.change_flags;
  if (!flags?.inputs || flags.nodes || flags.topology) return false;

  const sig = pc.inputs?.significant_by_node;
  if (!sig || typeof sig !== 'object' || Object.keys(sig).length === 0) return true;

  // Prod may flag seed/image as "significant" even when only user-varying inputs drifted.
  for (const inputNames of Object.values(sig)) {
    if (!Array.isArray(inputNames)) continue;
    for (const inputName of inputNames) {
      if (!isUserVaryingInput(inputName, workflowType)) return false;
    }
  }
  return true;
}

/** Same buckets as the daily failed-runs SQL CASE expression. */
export function classifySwatCategory(run, workflowType = null) {
  if (run.baseIsVerified !== true) return 'unverified';

  const flags = run.promptChanged?.change_flags;
  if (flags && typeof flags === 'object') {
    if (flags.nodes || flags.topology) return 'verified_changed';
    if (flags.inputs) {
      if (isIgnorableInputDriftOnly(run, workflowType)) return 'verified_unchanged_input_unchanged';
      return 'verified_unchanged_input_changed';
    }
    return 'verified_unchanged_input_unchanged';
  }

  if (run.promptChanged && typeof run.promptChanged === 'object') {
    if (run.promptChanged.changed === false) return 'verified_unchanged_input_unchanged';
    if (run.promptChanged.changed === true) return 'verified_changed';
  }

  if (typeof run.basePromptChanged === 'boolean') {
    return run.basePromptChanged ? 'verified_changed' : 'verified_unchanged_input_unchanged';
  }

  // Legacy verified runs before prompt_changed existed.
  return 'verified_unchanged_input_unchanged';
}

export function isTrustedBaselineRun(run) {
  const workflowType = detectWorkflowType(run.workflowJson);
  return classifySwatCategory(run, workflowType) === 'verified_unchanged_input_unchanged';
}

/**
 * Get the ignore list for a given workflow type.
 * Falls back to _default if no specific type match.
 */
export function getIgnoreFields(workflowType) {
  if (workflowType && ignoreFieldsConfig[workflowType]) {
    return ignoreFieldsConfig[workflowType];
  }
  return ignoreFieldsConfig._default || ['image', 'seed', 'text'];
}

/**
 * Detect workflow type from workflow_json by looking at node class_type values.
 */
export function detectWorkflowType(workflowJson) {
  if (!workflowJson) return null;
  const jsonStr = JSON.stringify(workflowJson).toLowerCase();

  if (jsonStr.includes('flux') && jsonStr.includes('inpaint')) return 'flux_inpaint';
  if (jsonStr.includes('nano_banana') || jsonStr.includes('nanobanana')) return 'nano_banana';
  if (jsonStr.includes('seedance')) return 'seedance';
  if (jsonStr.includes('kling')) return 'kling';
  if (jsonStr.includes('ltx')) return 'ltx';
  if (jsonStr.includes('wan')) return 'wan';

  return null;
}

/** Session/user inputs — drift here is "input changed", not infra outdated. */
const USER_VARYING_INPUTS = new Set([
  'image',
  'images',
  'mask',
  'audio',
  'audioUI',
  'audio_path',
  'video',
  'video-preview',
  'file',
  'filename',
  'path',
  'url',
  'seed',
  'noise_seed',
  'rand_seed',
  'text',
  'prompt',
  'negative_prompt',
  'floyo_text_0',
  'reference_image',
  'positive',
  'negative',
  'string',
  'value',
  'filename_prefix',
  'output_path',
  // PreviewAny UI fields — not execution inputs (schema migrated preview → previewMode, etc.)
  'preview',
  'previewMode',
  'preview_text',
  'preview_markdown',
]);

function isGraphStableRun(run) {
  const flags = run?.promptChanged?.change_flags;
  if (!flags || typeof flags !== 'object') return true;
  return !flags.nodes && !flags.topology;
}

export function isUserVaryingInput(inputName, workflowType = null) {
  const ignoreFields = new Set(getIgnoreFields(workflowType));
  if (ignoreFields.has(inputName)) return true;
  return USER_VARYING_INPUTS.has(inputName);
}

function isIgnoredEquivalenceInput(nodeId, inputName, run) {
  const ignored = run?.promptChanged?.inputs?.ignored_for_equivalence;
  if (!ignored || typeof ignored !== 'object') return false;
  const nodeIgnored = ignored[nodeId];
  return Array.isArray(nodeIgnored) && nodeIgnored.includes(inputName);
}

/**
 * Union of input keys seen on recent graph-stable successful runs.
 * Represents what current infra expects without treating one user's upload
 * as the schema source of truth.
 */
export function buildSchemaInputKeys(runs) {
  const keysByNode = {};

  for (const run of runs) {
    if (!run?.prompt || !isGraphStableRun(run)) continue;

    for (const [nodeId, node] of Object.entries(run.prompt)) {
      if (!node || typeof node !== 'object') continue;
      const inputs = node.inputs && typeof node.inputs === 'object' ? node.inputs : {};
      if (!keysByNode[nodeId]) keysByNode[nodeId] = new Set();
      for (const inputName of Object.keys(inputs)) {
        keysByNode[nodeId].add(inputName);
      }
    }
  }

  return keysByNode;
}

/**
 * Missing non-user input keys on the trusted baseline vs recent graph-stable schema.
 */
export function findInfraMissingFromSchema(
  baselinePrompt,
  schemaKeysByNode,
  referenceRuns,
  workflowType = null
) {
  if (!baselinePrompt || !schemaKeysByNode) return [];

  const missing = [];
  for (const [nodeId, keys] of Object.entries(schemaKeysByNode)) {
    const baseNode = baselinePrompt[nodeId];
    if (!baseNode || typeof baseNode !== 'object') continue;

    const baseInputs = baseNode.inputs && typeof baseNode.inputs === 'object' ? baseNode.inputs : {};

    for (const inputName of keys) {
      if (inputName in baseInputs) continue;
      if (isUserVaryingInput(inputName, workflowType)) continue;
      if (referenceRuns.some((run) => isIgnoredEquivalenceInput(nodeId, inputName, run))) {
        continue;
      }

      missing.push({
        nodeId,
        classType: baseNode.class_type,
        input: inputName,
      });
    }
  }

  return missing;
}

/**
 * True when the latest successful run only differs from base by user/session inputs
 * (image upload, seed, text, etc.) — not by graph or infra schema.
 */
function latestRunIsUserInputDriftOnly(latestRun) {
  const flags = latestRun?.promptChanged?.change_flags;
  if (!flags) return false;
  return Boolean(flags.inputs && !flags.nodes && !flags.topology);
}

export function detectOutdatedBaseline(trustedRun, latestRun, recentRuns = [], workflowType = null) {
  if (!trustedRun?.prompt || !latestRun?.prompt) return null;
  if (trustedRun.runId && latestRun.runId && trustedRun.runId === latestRun.runId) {
    return null;
  }

  const trustedAt = trustedRun.createdAt ? Date.parse(trustedRun.createdAt) : NaN;
  const latestAt = latestRun.createdAt ? Date.parse(latestRun.createdAt) : NaN;
  if (!Number.isFinite(trustedAt) || !Number.isFinite(latestAt) || latestAt <= trustedAt) {
    return null;
  }

  const referenceRuns = recentRuns.length > 0 ? recentRuns : [latestRun];
  const schemaKeysByNode = buildSchemaInputKeys(referenceRuns);
  const infraMissing = findInfraMissingFromSchema(
    trustedRun.prompt,
    schemaKeysByNode,
    referenceRuns,
    workflowType
  );

  if (infraMissing.length === 0) return null;

  // User uploaded a new image / changed seed: input-changed, not infra-outdated.
  if (latestRunIsUserInputDriftOnly(latestRun)) {
    const sig = latestRun.promptChanged?.inputs?.significant_by_node ?? {};
    const onlyUserDrift = infraMissing.every(({ nodeId, input }) => {
      if (isUserVaryingInput(input, workflowType)) return true;
      const nodeSig = sig[nodeId];
      return (
        Array.isArray(nodeSig) &&
        nodeSig.includes(input) &&
        nodeSig.every((name) => isUserVaryingInput(name, workflowType))
      );
    });
    if (onlyUserDrift) return null;
  }

  const examples = infraMissing
    .slice(0, 3)
    .map(({ nodeId, classType, input }) => `node ${nodeId} (${classType}).${input}`)
    .join(', ');

  return {
    missingInputs: infraMissing,
    reason: `Baseline outdated (missing infra fields: ${examples}). Run + Publish in the Floyo editor to refresh.`,
  };
}

/**
 * Extract all #community_inputs/ file paths from a prompt JSON object.
 * Walks parsed JSON so filenames with spaces/parentheses stay intact.
 */
export function extractCommunityInputPaths(promptJson) {
  const paths = new Set();
  const parsed =
    typeof promptJson === 'string' ? parseMaybeJson(promptJson) ?? promptJson : promptJson;

  function walk(value) {
    if (typeof value === 'string') {
      if (value.startsWith('#community_inputs/')) {
        paths.add(value.trim());
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (value && typeof value === 'object') {
      Object.values(value).forEach(walk);
    }
  }

  walk(parsed);

  // Fallback: extract quoted JSON strings (handles unparsed prompt blobs).
  if (paths.size === 0) {
    const jsonStr = typeof promptJson === 'string' ? promptJson : JSON.stringify(promptJson);
    const quoted = /"#community_inputs\/(?:[^"\\]|\\.)*"/g;
    let match;
    while ((match = quoted.exec(jsonStr)) !== null) {
      try {
        paths.add(JSON.parse(match[0]));
      } catch {
        paths.add(match[0].slice(1, -1));
      }
    }
  }

  return Array.from(paths);
}

/**
 * Convert a Comfy prompt path to a file_system_items.full_path.
 * e.g. "#community_inputs/abc/file.png" → "community_inputs/abc/file.png"
 *
 * Floyo stores community inputs in file_system_items (+ R2 via storage_object_id),
 * NOT in a Supabase Storage bucket named "community_inputs".
 */
export function communityInputFullPath(rawPath) {
  return rawPath.replace(/^#/, '');
}

/**
 * Check if community input files exist via file_system_items (prod source of truth).
 * Returns { allExist: boolean, missing: string[] }
 */
export async function checkCommunityInputFiles(paths, supabaseClient) {
  if (!paths || paths.length === 0) {
    return { allExist: true, missing: [] };
  }
  if (!supabaseClient) {
    return { allExist: true, missing: [] };
  }

  const missing = [];

  for (const rawPath of paths) {
    try {
      const fullPath = communityInputFullPath(rawPath);
      const { data, error } = await supabaseClient
        .from('file_system_items')
        .select('id, storage_object_id')
        .eq('full_path', fullPath)
        .eq('is_folder', false)
        .is('deleted_at', null)
        .is('team_id', null)
        .maybeSingle();

      if (error || !data?.storage_object_id) {
        missing.push(rawPath);
      }
    } catch {
      missing.push(rawPath);
    }
  }

  return { allExist: missing.length === 0, missing };
}

const RUN_SELECT =
  'id, prompt, workflow_json, created_at, prompt_changed, base_prompt_changed, base_is_verified';

async function scanSuccessfulRuns(workflowId, { pickTrusted = false, maxPages = 1 } = {}) {
  const supabase = getClient();
  if (!supabase) return { latestRun: null, trustedRun: null, recentRuns: [] };

  const pageSize = 100;
  let latestRun = null;
  let trustedRun = null;
  const recentRuns = [];
  const maxRecentRuns = 30;

  for (let page = 0; page < maxPages; page++) {
    const from = page * pageSize;
    const to = from + pageSize - 1;

    const { data, error } = await supabase
      .from('workflow_runs')
      .select(RUN_SELECT)
      .eq('base_workflow_id', workflowId)
      .eq('status', 'done')
      .not('prompt', 'is', null)
      .order('created_at', { ascending: false })
      .range(from, to);

    if (error || !data?.length) break;

    for (const row of data) {
      const run = mapRunRow(row);
      if (!run) continue;
      if (!latestRun) latestRun = run;
      if (recentRuns.length < maxRecentRuns) recentRuns.push(run);
      if (pickTrusted && !trustedRun && isTrustedBaselineRun(run)) {
        trustedRun = run;
      }
    }

    if (pickTrusted && trustedRun && recentRuns.length >= maxRecentRuns) break;
    if (data.length < pageSize) break;
  }

  return { latestRun, trustedRun, recentRuns };
}

/** Latest successful run + newest SQL-trusted baseline (may differ). */
export async function fetchBaselineContext(workflowId) {
  if (!workflowId) return { latestRun: null, trustedRun: null, recentRuns: [] };

  const baselineMode = (process.env.SWAT_BASELINE_MODE || 'graph').toLowerCase();
  const maxPages = baselineMode === 'prompt_changed' ? 20 : 1;
  const pickTrusted = baselineMode === 'prompt_changed';

  return scanSuccessfulRuns(workflowId, { pickTrusted, maxPages });
}

export async function fetchLatestSuccessfulRun(workflowId) {
  if (!workflowId) return null;

  const baselineMode = (process.env.SWAT_BASELINE_MODE || 'graph').toLowerCase();
  const { latestRun, trustedRun } = await fetchBaselineContext(workflowId);

  if (baselineMode === 'prompt_changed') {
    return trustedRun ?? latestRun;
  }

  return latestRun;
}

export async function fetchLatestSuccessfulRunPrompt(workflowId) {
  const run = await fetchLatestSuccessfulRun(workflowId);
  return run?.prompt ?? null;
}

/** Read published graph + stored prompt when preflight sends workflow_id only. */
export async function fetchWorkflowDefinition(workflowId) {
  if (!workflowId) return null;

  const supabase = getClient();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from('workflows')
    .select('id, name, workflow_json, prompt')
    .eq('id', workflowId)
    .maybeSingle();

  if (error || !data) return null;
  return data;
}
