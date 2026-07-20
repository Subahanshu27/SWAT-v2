import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { createClient } from '@supabase/supabase-js';

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function loadEnv() {
  try {
    if (typeof process.loadEnvFile === 'function') {
      process.loadEnvFile(new URL('../../.env', import.meta.url));
    }
  } catch {
    /* no .env */
  }
}

export function createWorkflowDb() {
  const url = process.env.SUPABASE_DATA_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.SUPABASE_DATA_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in Swat_Prod/.env'
    );
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function loadJsonFile(path, baseDir = process.cwd()) {
  const abs = resolve(baseDir, path);
  const raw = await readFile(abs, 'utf8');
  try {
    return { abs, data: JSON.parse(raw) };
  } catch (err) {
    throw new Error(`Invalid JSON in ${abs}: ${err.message}`);
  }
}

export async function fileExists(path, baseDir = process.cwd()) {
  try {
    await access(resolve(baseDir, path));
    return true;
  } catch {
    return false;
  }
}

export function jsonSize(value) {
  if (value == null) return 0;
  return JSON.stringify(value).length;
}

export function summarizePayload(value) {
  if (value == null) return '(null)';
  if (typeof value !== 'object') return String(typeof value);
  if (Array.isArray(value?.nodes)) {
    return `UI graph — ${value.nodes.length} nodes (${jsonSize(value)} chars)`;
  }
  const keys = Object.keys(value);
  return `API prompt — ${keys.length} keys (${jsonSize(value)} chars)`;
}

export function isApiPromptShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  if (entries.length === 0) return false;
  return entries.every(([, node]) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
    return (
      typeof node.class_type === 'string' &&
      typeof node.inputs === 'object' &&
      node.inputs !== null
    );
  });
}

export function isUiGraphShape(value) {
  return !!value && typeof value === 'object' && Array.isArray(value.nodes);
}

export function validatePayload({ workflow_json, prompt }, { strictPrompt = true } = {}) {
  const warnings = [];
  if (workflow_json !== undefined) {
    if (workflow_json == null || typeof workflow_json !== 'object') {
      throw new Error('workflow_json must be a JSON object');
    }
    if (!isUiGraphShape(workflow_json) && !isApiPromptShape(workflow_json)) {
      warnings.push('workflow_json is not a typical UI graph (nodes[]) or API prompt');
    }
  }
  if (prompt !== undefined) {
    if (prompt == null || typeof prompt !== 'object' || Array.isArray(prompt)) {
      throw new Error('prompt must be a JSON object');
    }
    if (strictPrompt && !isApiPromptShape(prompt)) {
      throw new Error('prompt is not a valid Comfy API prompt (nodeId -> { class_type, inputs })');
    }
    if (!strictPrompt && !isApiPromptShape(prompt)) {
      warnings.push('prompt does not look like a Comfy API prompt');
    }
  }
  return warnings;
}

export async function fetchWorkflow(sb, workflowId) {
  const { data, error } = await sb
    .from('workflows')
    .select('id, name, workflow_json, prompt, created_at, updated_at')
    .eq('id', workflowId)
    .maybeSingle();

  if (error) throw new Error(`Fetch failed for ${workflowId}: ${error.message}`);
  if (!data) throw new Error(`Workflow not found: ${workflowId}`);
  return data;
}

export async function exportWorkflowBackup(current, outPath) {
  const backup = {
    exported_at: new Date().toISOString(),
    workflow: {
      id: current.id,
      name: current.name,
      workflow_json: current.workflow_json,
      prompt: current.prompt,
      created_at: current.created_at,
      updated_at: current.updated_at,
    },
  };
  const abs = resolve(outPath);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, `${JSON.stringify(backup, null, 2)}\n`, 'utf8');
  return abs;
}

export async function applyWorkflowPatch(sb, workflowId, patch) {
  const updateRow = {
    ...patch,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await sb
    .from('workflows')
    .update(updateRow)
    .eq('id', workflowId)
    .select('id, name, updated_at')
    .single();
  if (error) throw new Error(`Update failed for ${workflowId}: ${error.message}`);
  return data;
}

const WORKFLOW_JSON_NAMES = [
  'workflow.json',
  'workflow_json.json',
  'graph.json',
  'workflow-graph.json',
];

const PROMPT_NAMES = ['prompt.json', 'api-prompt.json', 'prompt.api.json'];

export async function resolvePairFiles(dir, workflowId) {
  const folder = join(dir, workflowId);
  let wfPath = null;
  let promptPath = null;

  for (const name of WORKFLOW_JSON_NAMES) {
    const candidate = join(folder, name);
    if (await fileExists(candidate)) {
      wfPath = candidate;
      break;
    }
  }
  for (const name of PROMPT_NAMES) {
    const candidate = join(folder, name);
    if (await fileExists(candidate)) {
      promptPath = candidate;
      break;
    }
  }

  if (!wfPath) {
    const flatWf = [
      join(dir, `${workflowId}.workflow.json`),
      join(dir, `${workflowId}.graph.json`),
    ];
    for (const candidate of flatWf) {
      if (await fileExists(candidate)) {
        wfPath = candidate;
        break;
      }
    }
  }
  if (!promptPath) {
    const flatPrompt = join(dir, `${workflowId}.prompt.json`);
    if (await fileExists(flatPrompt)) promptPath = flatPrompt;
  }

  return { workflowJsonPath: wfPath, promptPath };
}

export async function confirmBulkApply(count) {
  if (process.env.SWAT_UPDATE_SKIP_CONFIRM === '1') return;
  console.log(`\nAbout to UPDATE ${count} prod workflow row(s).`);
  console.log('Re-run with --yes to skip this prompt, or Ctrl+C to abort.');
  process.stdout.write(`Type APPLY ${count} to continue: `);

  const answer = await new Promise((resolveAnswer) => {
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (chunk) => resolveAnswer(String(chunk).trim()));
  });

  if (answer !== `APPLY ${count}`) {
    console.log('Aborted.');
    process.exit(1);
  }
}
