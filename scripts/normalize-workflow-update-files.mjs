/**
 * Rename Floyo export files inside workflow-updates/<uuid>/ folders:
 *   "Some Workflow (1).json"  -> prompt.json
 *   "Some Workflow.json"      -> workflow.json
 *
 * Only touches immediate UUID subfolders of the target directory.
 * Default: dry-run. Pass --apply to rename.
 *
 * Examples:
 *   node scripts/normalize-workflow-update-files.mjs
 *   node scripts/normalize-workflow-update-files.mjs --dir ../workflow-updates
 *   node scripts/normalize-workflow-update-files.mjs --apply
 */
import { readdir, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROMPT_SUFFIX_RE = /\s*\(1\)\.json$/i;

function usage(exitCode = 0) {
  console.log(`Usage: node scripts/normalize-workflow-update-files.mjs [options]

Options:
  --dir <folder>   workflow-updates root (default: ../workflow-updates)
  --apply          Actually rename files (default: dry-run)
  -h, --help       Show help
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const opts = { dir: '../workflow-updates', apply: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') usage(0);
    if (arg === '--apply') {
      opts.apply = true;
      continue;
    }
    if (arg === '--dir') {
      opts.dir = argv[++i];
      if (!opts.dir) usage(1);
      continue;
    }
    console.error(`Unknown option: ${arg}`);
    usage(1);
  }
  return opts;
}

function isPromptExport(name) {
  return name.endsWith('.json') && PROMPT_SUFFIX_RE.test(name);
}

function isWorkflowExport(name) {
  if (!name.endsWith('.json')) return false;
  if (name === 'workflow.json' || name === 'prompt.json') return false;
  return !PROMPT_SUFFIX_RE.test(name);
}

function planFolderRenames(folderName, files) {
  const jsonFiles = files.filter((f) => f.endsWith('.json'));
  const alreadyWorkflow = jsonFiles.includes('workflow.json');
  const alreadyPrompt = jsonFiles.includes('prompt.json');

  const promptSources = jsonFiles.filter(isPromptExport);
  const workflowSources = jsonFiles.filter(isWorkflowExport);

  const renames = [];
  const notes = [];

  if (alreadyWorkflow) notes.push('workflow.json already present — skip workflow rename');
  if (alreadyPrompt) notes.push('prompt.json already present — skip prompt rename');

  if (!alreadyPrompt) {
    if (promptSources.length === 0) notes.push('no *(1).json prompt export found');
    else if (promptSources.length > 1) {
      throw new Error(`multiple *(1).json files: ${promptSources.join(', ')}`);
    } else {
      renames.push({ from: promptSources[0], to: 'prompt.json' });
    }
  }

  if (!alreadyWorkflow) {
    if (workflowSources.length === 0) notes.push('no plain *.json workflow export found');
    else if (workflowSources.length > 1) {
      throw new Error(`multiple workflow *.json files: ${workflowSources.join(', ')}`);
    } else {
      renames.push({ from: workflowSources[0], to: 'workflow.json' });
    }
  }

  return { folderName, renames, notes };
}

const opts = parseArgs(process.argv.slice(2));
const rootDir = resolve(process.cwd(), opts.dir);

async function main() {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const folders = entries.filter((e) => e.isDirectory() && UUID_RE.test(e.name)).map((e) => e.name);

  if (folders.length === 0) {
    console.error(`No UUID subfolders found in ${rootDir}`);
    process.exit(1);
  }

  console.log(`Normalize workflow export filenames`);
  console.log(`Root: ${rootDir}`);
  console.log(`Mode: ${opts.apply ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`Folders: ${folders.length}\n`);

  let planned = 0;
  let skipped = 0;
  let errors = 0;

  for (const folder of folders.sort()) {
    const folderPath = join(rootDir, folder);
    const files = await readdir(folderPath);

    try {
      const { renames, notes } = planFolderRenames(folder, files);
      if (renames.length === 0) {
        skipped += 1;
        console.log(`- ${folder}`);
        for (const n of notes) console.log(`    (${n})`);
        continue;
      }

      console.log(`→ ${folder}`);
      for (const { from, to } of renames) {
        console.log(`    ${from}  ->  ${to}`);
        planned += 1;
        if (opts.apply) {
          await rename(join(folderPath, from), join(folderPath, to));
        }
      }
      for (const n of notes) console.log(`    (${n})`);
    } catch (err) {
      errors += 1;
      console.error(`✗ ${folder}: ${err.message}`);
    }
  }

  console.log('\n---');
  console.log(`Renames: ${planned}${opts.apply ? ' applied' : ' planned'}`);
  console.log(`Skipped folders (already ok / incomplete): ${skipped}`);
  if (errors) console.log(`Errors: ${errors}`);

  if (!opts.apply && planned > 0) {
    console.log('\nDry-run only. Re-run with --apply to rename.');
  }

  if (errors > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
