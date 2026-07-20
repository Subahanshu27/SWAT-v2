/**
 * Bulk-update `workflows.workflow_json` and/or `workflows.prompt` in prod Supabase.
 *
 * SAFETY:
 * - Default is dry-run (no DB writes).
 * - With --apply, exports a backup JSON per workflow first (unless --no-backup).
 * - Validates every row before writing any row (--apply aborts on first validation error).
 * - Optional expected name check (--strict-names).
 *
 * Setup folder (recommended):
 *   workflow-updates/
 *     46201eba-a692-4964-a193-db81cf8c9954/
 *       workflow.json
 *       prompt.json
 *     0190bfea-870c-4ddd-872d-eef1a47089e0/
 *       workflow.json
 *       prompt.json
 *
 * Or manifest.json:
 *   {
 *     "items": [
 *       {
 *         "workflow_id": "46201eba-a692-4964-a193-db81cf8c9954",
 *         "expected_name": "Video Masking with Sam2 Comparison",
 *         "workflow_json": "46201eba-a692-4964-a193-db81cf8c9954/workflow.json",
 *         "prompt": "46201eba-a692-4964-a193-db81cf8c9954/prompt.json"
 *       }
 *     ]
 *   }
 *
 * Examples:
 *   # Scan folder — dry-run
 *   node scripts/bulk-update-workflows.mjs --dir ../workflow-updates
 *
 *   # From manifest
 *   node scripts/bulk-update-workflows.mjs --manifest ../workflow-updates/manifest.json
 *
 *   # Apply + backups + clear prompt-service cache
 *   node scripts/bulk-update-workflows.mjs --dir ../workflow-updates --apply --clear-cache
 *
 * IMPORTANT:
 * - This updates the `workflows` table only (Publish-equivalent data patch).
 * - SWAT baseline trust still comes from `workflow_runs`. After bulk patch, each workflow
 *   still needs Floyo Run + Publish + SWAT Re-check to clear stale/outdated preflight.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import {
  UUID_RE,
  loadEnv,
  createWorkflowDb,
  loadJsonFile,
  summarizePayload,
  validatePayload,
  fetchWorkflow,
  exportWorkflowBackup,
  applyWorkflowPatch,
  resolvePairFiles,
  confirmBulkApply,
} from './lib/workflow-update-lib.mjs';

loadEnv();

function usage(exitCode = 0) {
  console.log(`Usage: node scripts/bulk-update-workflows.mjs (--dir <folder> | --manifest <file>) [options]

Options:
  --dir <folder>           Folder with subdirs named by workflow UUID
  --manifest <file.json>   Explicit list of workflow_id + file paths
  --ids <id1,id2,...>      Only process these IDs (subset filter)
  --backup-dir <folder>    Where to save pre-update backups (default: ./workflow-backups/<timestamp>)
  --no-backup              Skip backup export (not recommended)
  --strict-names           Fail if DB name != expected_name in manifest
  --apply                  Write to Supabase (default: dry-run)
  --yes                    Skip typed confirmation on --apply
  --clear-cache            POST /cache/clear-workflow for each updated ID (needs prompt-service)
  -h, --help               Show help
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const opts = {
    dir: null,
    manifest: null,
    ids: null,
    backupDir: null,
    noBackup: false,
    strictNames: false,
    apply: false,
    yes: false,
    clearCache: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') usage(0);
    if (arg === '--apply') {
      opts.apply = true;
      continue;
    }
    if (arg === '--yes') {
      opts.yes = true;
      continue;
    }
    if (arg === '--no-backup') {
      opts.noBackup = true;
      continue;
    }
    if (arg === '--strict-names') {
      opts.strictNames = true;
      continue;
    }
    if (arg === '--clear-cache') {
      opts.clearCache = true;
      continue;
    }
    if (arg === '--dir') {
      opts.dir = argv[++i];
      if (!opts.dir) usage(1);
      continue;
    }
    if (arg === '--manifest') {
      opts.manifest = argv[++i];
      if (!opts.manifest) usage(1);
      continue;
    }
    if (arg === '--backup-dir') {
      opts.backupDir = argv[++i];
      if (!opts.backupDir) usage(1);
      continue;
    }
    if (arg === '--ids') {
      opts.ids = argv[++i];
      if (!opts.ids) usage(1);
      continue;
    }
    console.error(`Unknown option: ${arg}`);
    usage(1);
  }

  if (!opts.dir && !opts.manifest) {
    console.error('Provide --dir or --manifest');
    usage(1);
  }
  if (opts.dir && opts.manifest) {
    console.error('Use only one of --dir or --manifest');
    usage(1);
  }

  const idFilter = opts.ids
    ? new Set(
        opts.ids
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      )
    : null;

  if (idFilter) {
    for (const id of idFilter) {
      if (!UUID_RE.test(id)) {
        console.error(`Invalid workflow id in --ids: ${id}`);
        process.exit(1);
      }
    }
  }

  return { opts, idFilter };
}

async function loadManifestItems(manifestPath) {
  const abs = resolve(manifestPath);
  const baseDir = dirname(abs);
  const { data } = await loadJsonFile(abs);
  const items = Array.isArray(data) ? data : data?.items;
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error(`Manifest must be { "items": [...] } — ${abs}`);
  }

  return items.map((item, index) => {
    const workflowId = item.workflow_id || item.workflowId || item.id;
    if (!workflowId || !UUID_RE.test(workflowId)) {
      throw new Error(`Manifest item ${index}: invalid workflow_id`);
    }
    if (!item.workflow_json && !item.prompt) {
      throw new Error(`Manifest item ${index} (${workflowId}): need workflow_json and/or prompt path`);
    }
    return {
      workflowId,
      expectedName: item.expected_name || item.name || null,
      workflowJsonPath: item.workflow_json ? resolve(baseDir, item.workflow_json) : null,
      promptPath: item.prompt ? resolve(baseDir, item.prompt) : null,
    };
  });
}

async function loadDirItems(dirPath, idFilter) {
  const absDir = resolve(dirPath);
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(absDir, { withFileTypes: true });

  const workflowIds = entries
    .filter((e) => e.isDirectory() && UUID_RE.test(e.name))
    .map((e) => e.name);

  // Also pick up flat files like <uuid>.workflow.json at root
  for (const e of entries) {
    if (!e.isFile()) continue;
    const m = e.name.match(/^([0-9a-f-]{36})\.(workflow|graph)\.json$/i);
    if (m && UUID_RE.test(m[1])) workflowIds.push(m[1]);
  }

  const uniqueIds = [...new Set(workflowIds)].filter((id) => !idFilter || idFilter.has(id));
  if (uniqueIds.length === 0) {
    throw new Error(`No workflow UUID folders/files found in ${absDir}`);
  }

  const items = [];
  for (const workflowId of uniqueIds.sort()) {
    const { workflowJsonPath, promptPath } = await resolvePairFiles(absDir, workflowId);
    if (!workflowJsonPath && !promptPath) {
      console.warn(`  skip ${workflowId}: no workflow.json / prompt.json found`);
      continue;
    }
    items.push({ workflowId, expectedName: null, workflowJsonPath, promptPath });
  }

  if (items.length === 0) {
    throw new Error(`No updatable workflows found in ${absDir}`);
  }
  return items;
}

async function clearPromptCache(workflowId) {
  const base = (process.env.FLOYO_PROMPT_SERVICE_URL || 'http://127.0.0.1:8788/generate-prompt')
    .replace(/\/generate-prompt\/?$/, '');
  try {
    await fetch(`${base}/cache/clear-workflow`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflow_id: workflowId }),
    });
  } catch (err) {
    console.warn(`  cache clear failed for ${workflowId}:`, err.message);
  }
}

async function buildPlanItem(item) {
  /** @type {{ workflow_json?: unknown; prompt?: unknown }} */
  const patch = {};
  if (item.workflowJsonPath) {
    const { data } = await loadJsonFile(item.workflowJsonPath);
    patch.workflow_json = data;
  }
  if (item.promptPath) {
    const { data } = await loadJsonFile(item.promptPath);
    patch.prompt = data;
  }
  return patch;
}

const { opts, idFilter } = parseArgs(process.argv.slice(2));

const items = opts.manifest
  ? await loadManifestItems(opts.manifest)
  : await loadDirItems(opts.dir, idFilter);

const filtered = idFilter ? items.filter((i) => idFilter.has(i.workflowId)) : items;
if (filtered.length === 0) {
  console.error('No items to process after --ids filter');
  process.exit(1);
}

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupRoot = resolve(opts.backupDir || join('workflow-backups', timestamp));

console.log(`Bulk workflow update — ${filtered.length} item(s)`);
console.log(`Mode: ${opts.apply ? 'APPLY (writes to prod)' : 'DRY-RUN (no writes)'}`);
if (opts.apply && !opts.noBackup) console.log(`Backups: ${backupRoot}`);
console.log('');

const sb = createWorkflowDb();
/** @type {Array<{ workflowId: string; name: string; status: string; detail: string }>} */
const report = [];

/** @type {Array<{ item: typeof filtered[0]; current: Awaited<ReturnType<typeof fetchWorkflow>>; patch: object; warnings: string[] }>} */
const validated = [];

for (const item of filtered) {
  const header = `${item.workflowId}`;
  try {
    const current = await fetchWorkflow(sb, item.workflowId);
    if (item.expectedName && opts.strictNames && current.name !== item.expectedName) {
      throw new Error(
        `Name mismatch: DB="${current.name}" expected="${item.expectedName}" (use correct ID or drop --strict-names)`
      );
    }
    if (item.expectedName && current.name !== item.expectedName) {
      console.warn(`  warning ${header}: DB name "${current.name}" != expected "${item.expectedName}"`);
    }

    const patch = await buildPlanItem(item);
    if (Object.keys(patch).length === 0) {
      throw new Error('No workflow_json or prompt files resolved');
    }
    const warnings = validatePayload(patch);

    console.log(`✓ ${current.name}`);
    console.log(`  id: ${item.workflowId}`);
    console.log(`  current workflow_json: ${summarizePayload(current.workflow_json)}`);
    console.log(`  current prompt:          ${summarizePayload(current.prompt)}`);
    if (patch.workflow_json) {
      console.log(`  new workflow_json:       ${summarizePayload(patch.workflow_json)}`);
    }
    if (patch.prompt) {
      console.log(`  new prompt:              ${summarizePayload(patch.prompt)}`);
    }
    for (const w of warnings) console.warn(`  warning: ${w}`);
    console.log('');

    validated.push({ item, current, patch, warnings });
    report.push({ workflowId: item.workflowId, name: current.name, status: 'validated', detail: 'ok' });
  } catch (err) {
    console.error(`✗ ${header}: ${err.message}\n`);
    report.push({ workflowId: item.workflowId, name: item.expectedName || '?', status: 'error', detail: err.message });
  }
}

const errors = report.filter((r) => r.status === 'error');
if (errors.length > 0) {
  console.error(`${errors.length} validation error(s) — nothing will be written.`);
  process.exit(1);
}

if (!opts.apply) {
  console.log('Dry-run complete — all items validated.');
  console.log('To apply:');
  console.log(
    `  node scripts/bulk-update-workflows.mjs ${opts.manifest ? `--manifest ${opts.manifest}` : `--dir ${opts.dir}`} --apply`
  );
  console.log('\nReminder: after DB patch, each workflow still needs Floyo Run + Publish + SWAT Re-check.');
  process.exit(0);
}

if (!opts.yes) {
  await confirmBulkApply(validated.length);
}

await mkdir(backupRoot, { recursive: true });
const manifestOut = [];

for (const { item, current, patch } of validated) {
  try {
    if (!opts.noBackup) {
      const backupPath = join(backupRoot, `${item.workflowId}.backup.json`);
      await exportWorkflowBackup(current, backupPath);
    }

    const updated = await applyWorkflowPatch(sb, item.workflowId, patch);
    if (opts.clearCache) await clearPromptCache(item.workflowId);

    manifestOut.push({
      workflow_id: item.workflowId,
      name: updated.name,
      updated_at: updated.updated_at,
      files: {
        workflow_json: item.workflowJsonPath,
        prompt: item.promptPath,
      },
    });

    const idx = report.findIndex((r) => r.workflowId === item.workflowId);
    if (idx >= 0) {
      report[idx] = {
        workflowId: item.workflowId,
        name: updated.name,
        status: 'updated',
        detail: updated.updated_at,
      };
    }
    console.log(`OK  ${updated.name} (${item.workflowId})`);
  } catch (err) {
    console.error(`FAIL ${item.workflowId}: ${err.message}`);
    report.push({ workflowId: item.workflowId, name: current.name, status: 'failed', detail: err.message });
  }
}

const summaryPath = join(backupRoot, '_bulk-update-summary.json');
await writeFile(
  summaryPath,
  `${JSON.stringify({ updated_at: new Date().toISOString(), items: manifestOut, report }, null, 2)}\n`
);

console.log('\n--- Summary ---');
for (const row of report) {
  console.log(`${row.status.padEnd(10)} ${row.workflowId}  ${row.name}`);
}
console.log(`\nSummary file: ${summaryPath}`);
console.log('\nNext: Floyo Run + Publish on each workflow, then SWAT Re-check / preflight.');
