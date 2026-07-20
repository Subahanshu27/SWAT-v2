/**
 * Read or update `workflows.workflow_json` and/or `workflows.prompt` in prod Supabase.
 *
 * Uses Swat_Prod/.env (NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).
 *
 * Examples:
 *   # Show current row (read-only)
 *   node scripts/update-workflow-prompt.mjs <workflow-id> --show
 *
 *   # Export backup JSON
 *   node scripts/update-workflow-prompt.mjs <workflow-id> --export ./backup.json
 *
 *   # Update from local JSON files (dry-run first — no --apply)
 *   node scripts/update-workflow-prompt.mjs <workflow-id> \
 *     --workflow-json ./graph.json \
 *     --prompt ./api-prompt.json
 *
 *   # Apply update
 *   node scripts/update-workflow-prompt.mjs <workflow-id> \
 *     --workflow-json ./graph.json \
 *     --prompt ./api-prompt.json \
 *     --apply
 *
 *   # Copy graph + prompt from another workflow
 *   node scripts/update-workflow-prompt.mjs <target-id> --copy-from <source-id> --apply
 *
 *   # Update only one column
 *   node scripts/update-workflow-prompt.mjs <workflow-id> --prompt ./api-prompt.json --apply
 *
 * Notes:
 * - Default is dry-run. Pass --apply to write to the database.
 * - SWAT preflight baseline trust comes from workflow_runs, not workflows.prompt.
 *   Patching these columns alone may not unblock SWAT — Run + Publish in Floyo is still
 *   the reliable fix for baseline issues.
 */
import { createClient } from '@supabase/supabase-js';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

try {
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(new URL('../.env', import.meta.url));
  }
} catch {
  /* no .env */
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function usage(exitCode = 0) {
  console.log(`Usage: node scripts/update-workflow-prompt.mjs <workflow-id> [options]

Options:
  --show                     Print current workflow_json + prompt summary (default if no writes)
  --export <file.json>       Save current row to a JSON backup file
  --workflow-json <file>     Load workflow_json from a JSON file
  --prompt <file>            Load prompt from a JSON file
  --copy-from <workflow-id>  Copy workflow_json + prompt from another workflow
  --apply                    Write changes to Supabase (otherwise dry-run)
  --yes                      Skip confirmation prompt when using --apply
  -h, --help                 Show this help
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const positional = [];
  const opts = {
    show: false,
    exportPath: null,
    workflowJsonPath: null,
    promptPath: null,
    copyFrom: null,
    apply: false,
    yes: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') usage(0);
    if (arg === '--show') {
      opts.show = true;
      continue;
    }
    if (arg === '--apply') {
      opts.apply = true;
      continue;
    }
    if (arg === '--yes') {
      opts.yes = true;
      continue;
    }
    if (arg === '--export') {
      opts.exportPath = argv[++i];
      if (!opts.exportPath) usage(1);
      continue;
    }
    if (arg === '--workflow-json') {
      opts.workflowJsonPath = argv[++i];
      if (!opts.workflowJsonPath) usage(1);
      continue;
    }
    if (arg === '--prompt') {
      opts.promptPath = argv[++i];
      if (!opts.promptPath) usage(1);
      continue;
    }
    if (arg === '--copy-from') {
      opts.copyFrom = argv[++i];
      if (!opts.copyFrom) usage(1);
      continue;
    }
    if (arg.startsWith('-')) {
      console.error(`Unknown option: ${arg}`);
      usage(1);
    }
    positional.push(arg);
  }

  const workflowId = positional[0];
  if (!workflowId) usage(1);
  if (!UUID_RE.test(workflowId)) {
    console.error(`Invalid workflow id: ${workflowId}`);
    process.exit(1);
  }
  if (opts.copyFrom && !UUID_RE.test(opts.copyFrom)) {
    console.error(`Invalid --copy-from id: ${opts.copyFrom}`);
    process.exit(1);
  }

  return { workflowId, opts };
}

async function loadJsonFile(path) {
  const abs = resolve(path);
  const raw = await readFile(abs, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in ${abs}: ${err.message}`);
  }
}

function jsonSize(value) {
  if (value == null) return 0;
  return JSON.stringify(value).length;
}

function summarize(value, label) {
  if (value == null) {
    console.log(`  ${label}: (null)`);
    return;
  }
  if (typeof value !== 'object') {
    console.log(`  ${label}: ${typeof value}`);
    return;
  }
  if (Array.isArray(value?.nodes)) {
    console.log(`  ${label}: UI graph — ${value.nodes.length} nodes (${jsonSize(value)} chars)`);
    return;
  }
  const keys = Object.keys(value);
  console.log(`  ${label}: object — ${keys.length} keys (${jsonSize(value)} chars)`);
}

function isApiPromptShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  if (entries.length === 0) return false;
  return entries.every(([, node]) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
    return typeof node.class_type === 'string' && typeof node.inputs === 'object' && node.inputs !== null;
  });
}

function validatePayload({ workflow_json, prompt }) {
  if (workflow_json !== undefined) {
    if (workflow_json == null || typeof workflow_json !== 'object') {
      throw new Error('workflow_json must be a JSON object');
    }
  }
  if (prompt !== undefined) {
    if (prompt == null || typeof prompt !== 'object' || Array.isArray(prompt)) {
      throw new Error('prompt must be a JSON object');
    }
    if (!isApiPromptShape(prompt)) {
      console.warn(
        '  warning: prompt does not look like a Comfy API prompt (nodeId -> { class_type, inputs })'
      );
    }
  }
}

async function fetchWorkflow(sb, workflowId) {
  const { data, error } = await sb
    .from('workflows')
    .select('id, name, workflow_json, prompt, created_at, updated_at')
    .eq('id', workflowId)
    .maybeSingle();

  if (error) throw new Error(`Fetch failed: ${error.message}`);
  if (!data) throw new Error(`Workflow not found: ${workflowId}`);
  return data;
}

async function confirmApply(workflowId, patch) {
  if (process.env.SWAT_UPDATE_SKIP_CONFIRM === '1') return;
  console.log('\nAbout to UPDATE prod workflows row:');
  console.log(`  id: ${workflowId}`);
  if ('workflow_json' in patch) console.log('  workflow_json: yes');
  if ('prompt' in patch) console.log('  prompt: yes');
  console.log('\nRe-run with --yes to skip this prompt, or Ctrl+C to abort.');
  process.stdout.write('Type APPLY to continue: ');

  const answer = await new Promise((resolveAnswer) => {
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (chunk) => resolveAnswer(String(chunk).trim()));
  });

  if (answer !== 'APPLY') {
    console.log('Aborted.');
    process.exit(1);
  }
}

const { workflowId, opts } = parseArgs(process.argv.slice(2));

const url = process.env.SUPABASE_DATA_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const key =
  process.env.SUPABASE_DATA_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in Swat_Prod/.env');
  process.exit(1);
}

const sb = createClient(url, key, { auth: { persistSession: false } });

const current = await fetchWorkflow(sb, workflowId);

console.log('Workflow');
console.log(`  id:   ${current.id}`);
console.log(`  name: ${current.name || '(untitled)'}`);
console.log(`  created_at: ${current.created_at}`);
console.log(`  updated_at: ${current.updated_at}`);
summarize(current.workflow_json, 'workflow_json');
summarize(current.prompt, 'prompt');

if (opts.exportPath) {
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
  const out = resolve(opts.exportPath);
  await writeFile(out, `${JSON.stringify(backup, null, 2)}\n`, 'utf8');
  console.log(`\nExported backup -> ${out}`);
}

/** @type {{ workflow_json?: unknown; prompt?: unknown }} */
const patch = {};

if (opts.copyFrom) {
  const source = await fetchWorkflow(sb, opts.copyFrom);
  console.log(`\nCopy source: ${source.id} (${source.name || 'untitled'})`);
  patch.workflow_json = source.workflow_json;
  patch.prompt = source.prompt;
} else {
  if (opts.workflowJsonPath) {
    patch.workflow_json = await loadJsonFile(opts.workflowJsonPath);
  }
  if (opts.promptPath) {
    patch.prompt = await loadJsonFile(opts.promptPath);
  }
}

const hasWriteIntent =
  opts.exportPath != null ||
  Object.keys(patch).length > 0 ||
  opts.show ||
  opts.apply;

if (!hasWriteIntent || (Object.keys(patch).length === 0 && !opts.exportPath && !opts.show)) {
  if (Object.keys(patch).length === 0 && !opts.exportPath) {
    console.log('\n(read-only — pass --workflow-json / --prompt / --copy-from to prepare an update)');
  }
  process.exit(0);
}

if (Object.keys(patch).length === 0) {
  process.exit(0);
}

console.log('\nPlanned changes:');
if ('workflow_json' in patch) summarize(patch.workflow_json, 'new workflow_json');
if ('prompt' in patch) summarize(patch.prompt, 'new prompt');

try {
  validatePayload(patch);
} catch (err) {
  console.error(`Validation failed: ${err.message}`);
  process.exit(1);
}

if (!opts.apply) {
  console.log('\nDry-run only — no database write.');
  console.log('Add --apply to persist. Example:');
  console.log(
    `  node scripts/update-workflow-prompt.mjs ${workflowId} --workflow-json ./graph.json --prompt ./prompt.json --apply`
  );
  process.exit(0);
}

if (!opts.yes) {
  await confirmApply(workflowId, patch);
}

const updateRow = {
  ...patch,
  updated_at: new Date().toISOString(),
};

const { data: updated, error: updateError } = await sb
  .from('workflows')
  .update(updateRow)
  .eq('id', workflowId)
  .select('id, name, updated_at')
  .single();

if (updateError) {
  console.error('Update failed:', updateError.message);
  process.exit(1);
}

console.log('\nOK — workflows row updated');
console.log(updated);
