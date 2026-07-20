/**
 * Batch-wise wrapper for workflow update scripts.
 *
 * Folder convention:
 *   batch 1  -> ../workflow-updates
 *   batch 2  -> ../workflow-updates-2
 *   batch 3  -> ../workflow-updates-3
 *
 * Each batch folder must contain ids.txt (one UUID per line).
 *
 * Examples (run from Swat_Prod):
 *   npm run workflow:batch -- 2 init
 *   npm run workflow:batch -- 2 normalize --apply
 *   npm run workflow:batch -- 2 verify
 *   npm run workflow:batch -- 2 apply --yes
 */
import { spawnSync } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { access } from 'node:fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SWAT_PROD_ROOT = resolve(__dirname, '..');

function usage(exitCode = 0) {
  console.log(`Usage: node scripts/workflow-batch.mjs <batch-number> <command> [extra flags]

Commands:
  init       Create UUID folders + manifest from ids.txt
  normalize  Rename Floyo exports -> workflow.json / prompt.json
  verify     Dry-run bulk DB update
  apply      Write to prod workflows table (+ backup)

Batch folders:
  1 -> workflow-updates
  2 -> workflow-updates-2
  N -> workflow-updates-N

Examples:
  npm run workflow:batch -- 2 init
  npm run workflow:batch -- 2 normalize --apply
  npm run workflow:batch -- 2 verify
  npm run workflow:batch -- 2 apply --yes
`);
  process.exit(exitCode);
}

function batchDir(batch) {
  const n = Number(batch);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error('Batch number must be a positive integer (1, 2, 3, ...)');
  }
  return n === 1 ? '../workflow-updates' : `../workflow-updates-${n}`;
}

function runNode(scriptName, args) {
  const scriptPath = join(__dirname, scriptName);
  const res = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: SWAT_PROD_ROOT,
    stdio: 'inherit',
    env: process.env,
  });
  process.exit(res.status ?? 1);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length < 2 || argv[0] === '-h' || argv[0] === '--help') usage(0);

  const batch = argv[0];
  const command = argv[1];
  const extras = argv.slice(2);

  let dir;
  try {
    dir = batchDir(batch);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const idsFile = resolve(SWAT_PROD_ROOT, dir, 'ids.txt');
  try {
    await access(idsFile);
  } catch {
    console.error(`Missing ${idsFile}`);
    console.error('Create ids.txt with one workflow UUID per line, then retry.');
    process.exit(1);
  }

  console.log(`Batch ${batch} -> ${dir}\n`);

  switch (command) {
    case 'init':
      runNode('init-workflow-update-folders.mjs', [
        '--dir',
        dir,
        '--ids-file',
        join(dir, 'ids.txt'),
        '--write-manifest',
        ...extras,
      ]);
      break;
    case 'normalize':
      runNode('normalize-workflow-update-files.mjs', ['--dir', dir, ...extras]);
      break;
    case 'verify':
      runNode('bulk-update-workflows.mjs', ['--dir', dir, '--strict-names', ...extras]);
      break;
    case 'apply':
      runNode('bulk-update-workflows.mjs', [
        '--dir',
        dir,
        '--strict-names',
        '--apply',
        '--clear-cache',
        ...extras,
      ]);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      usage(1);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
