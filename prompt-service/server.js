import http from 'node:http';
import { createHash } from 'node:crypto';

// Load the local .env (Node >= 20.6) so SUPABASE_* are available no matter how
// the service is started (`node server.js`, `npm run dev`, etc.). Without this
// the Supabase client cannot init and the successful-run prompt lookup is a
// silent no-op. Existing process env vars are not overridden.
try {
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(new URL('./.env', import.meta.url));
  }
} catch {
  // No .env file present — rely on env provided by the shell / process manager.
}

import { resolvePromptLocally, isApiPromptShape, graphsMatch } from './lib/prompt.js';
import { cacheGet, cacheSet, getStats, cacheClear, clearByWorkflowId } from './lib/cache.js';
import {
  fetchBaselineContext,
  fetchWorkflowDefinition,
  classifySwatCategory,
  detectOutdatedBaseline,
  detectWorkflowType,
  extractPromptFilePaths,
  checkPromptInputFiles,
} from './lib/runPrompt.js';
import { createClient } from '@supabase/supabase-js';

const PORT = Number(process.env.PORT || 8788);
const HOST = process.env.HOST || '127.0.0.1';

const BASELINE_MODE = (process.env.SWAT_BASELINE_MODE || 'graph').toLowerCase();

function getSupabaseClient() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

function catalogCacheFingerprint(prompt, workflowJson) {
  const raw = JSON.stringify({
    p: prompt ?? null,
    // Prefer a light fingerprint of the graph when present
    n: Array.isArray(workflowJson?.nodes) ? workflowJson.nodes.length : null,
  });
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

function cacheKey(body, catalog = null) {
  const workflowId = body.workflow_id || '';
  if (catalog) {
    const fp = catalogCacheFingerprint(catalog.prompt, catalog.workflow_json);
    return createHash('sha256')
      .update(`catalog:${workflowId}:${BASELINE_MODE}:${fp}`)
      .digest('hex');
  }
  // Fallback before catalog load (should rarely be used for get)
  const raw = JSON.stringify({
    w: workflowId,
    j: body.workflow_json,
    p: body.prompt,
    m: BASELINE_MODE,
  });
  return createHash('sha256').update(raw).digest('hex');
}

async function fetchBaselineContextWithRetry(workflowId, attempts = 4) {
  let last = { trustedRun: null, latestRun: null, recentRuns: [] };
  for (let i = 0; i < attempts; i++) {
    last = await fetchBaselineContext(workflowId);
    if (last.trustedRun?.prompt || last.latestRun?.prompt) return last;
    if (i < attempts - 1) {
      await new Promise((r) => setTimeout(r, 200 * (i + 1)));
    }
  }
  return last;
}

const BASELINE_FETCH_MAX = 6;
let baselineFetchesActive = 0;
const baselineFetchWaiters = [];

function acquireBaselineSlot() {
  if (baselineFetchesActive < BASELINE_FETCH_MAX) {
    baselineFetchesActive++;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    baselineFetchWaiters.push(resolve);
  });
}

function releaseBaselineSlot() {
  baselineFetchesActive--;
  const next = baselineFetchWaiters.shift();
  if (next) {
    baselineFetchesActive++;
    next();
  }
}

async function fetchBaselineContextQueued(workflowId) {
  await acquireBaselineSlot();
  try {
    return await fetchBaselineContextWithRetry(workflowId);
  } finally {
    releaseBaselineSlot();
  }
}

function evaluateBaseline(trustedRun, latestRun, recentRuns, body) {
  const workflowType = detectWorkflowType(body.workflow_json);

  if (BASELINE_MODE === 'prompt_changed') {
    const category = classifySwatCategory(trustedRun, workflowType);

    if (category === 'verified_unchanged_input_unchanged') {
      const outdated = detectOutdatedBaseline(trustedRun, latestRun, recentRuns, workflowType);
      if (outdated) {
        return {
          baseline: 'outdated',
          strategy: 'prod_prompt_outdated_for_infra',
          reason: outdated.reason,
          category: 'prompt_baseline_outdated',
          outdatedDetails: outdated.missingInputs,
        };
      }

      return {
        baseline: 'exact',
        strategy: `prod_${category}`,
        reason: undefined,
      };
    }

    const reasons = {
      unverified:
        'No trusted baseline found — Run + Publish in the Floyo editor to create one.',
      verified_changed:
        'Workflow graph changed — Run + Publish in the Floyo editor to update baseline.',
      verified_unchanged_input_changed:
        'Baseline stale — Run + Publish this workflow in the Floyo editor to refresh.',
    };

    return {
      baseline: 'stale',
      strategy: `prod_${category}`,
      reason: reasons[category] || 'No trusted verified unchanged baseline found for this workflow.',
      category,
    };
  }

  const matches = trustedRun.workflowJson
    ? graphsMatch(trustedRun.workflowJson, body.workflow_json)
    : false;
  return {
    baseline: matches ? 'exact' : 'stale',
    strategy: matches ? 'latest_successful_run_exact' : 'latest_successful_run_stale',
    reason: undefined,
  };
}

async function checkPromptFilesBlock(promptJson) {
  const paths = extractPromptFilePaths(promptJson);
  if (paths.length === 0) return null;

  const supabase = getSupabaseClient();
  const fileCheck = await checkPromptInputFiles(paths, supabase);
  if (fileCheck.allExist) return null;

  return {
    baseline: 'community_input_missing',
    category: 'invalid_prompt_files',
    reason: `Referenced file not found in storage — fix paths in Floyo editor, then Run + Publish. Missing: ${fileCheck.missing.join(', ')}`,
    missing_files: fileCheck.missing,
  };
}

/**
 * Resolve catalog (workflows table) definition for dispatch.
 * UI loads from workflows — SWAT must dispatch the same prompt.
 */
async function loadCatalogDefinition(body) {
  let workflowJson = body.workflow_json ?? null;
  let prompt = body.prompt ?? null;

  if (body.workflow_id && (workflowJson == null || prompt == null)) {
    const row = await fetchWorkflowDefinition(body.workflow_id);
    if (row) {
      if (workflowJson == null) workflowJson = row.workflow_json;
      if (prompt == null) prompt = row.prompt;
    }
  }

  return { workflow_json: workflowJson, prompt };
}

async function handleGeneratePrompt(body) {
  // 1. Always load published catalog — this is the dispatch source of truth.
  const catalog = await loadCatalogDefinition(body);
  const key = cacheKey(body, catalog);
  const cached = cacheGet(key);
  if (cached) {
    return { ...cached, cached: true };
  }

  let baseline = body.workflow_id ? 'missing' : 'unknown';
  let baselineReason;
  let blockCategory;
  let baselineStrategy;
  let hadBaselineRun = false;

  // 2. Baseline/drift check against workflow_runs (trust gate only — never dispatch run prompt).
  if (body.workflow_id) {
    const { trustedRun, latestRun, recentRuns } = await fetchBaselineContextQueued(
      body.workflow_id
    );
    const baselineRun = trustedRun ?? latestRun;
    if (baselineRun?.prompt) {
      hadBaselineRun = true;
      const evaluated = evaluateBaseline(baselineRun, latestRun, recentRuns, {
        ...body,
        workflow_json: catalog.workflow_json ?? body.workflow_json,
      });
      baseline = evaluated.baseline;
      baselineReason = evaluated.reason;
      blockCategory = evaluated.category;
      baselineStrategy = evaluated.strategy;
    }
  }

  // 3. Build dispatch prompt from workflows catalog (same as UI).
  const local = resolvePromptLocally({
    workflow_json: catalog.workflow_json,
    prompt: catalog.prompt,
  });

  let result = null;
  if (local?.prompt) {
    result = {
      prompt: local.prompt,
      source: 'workflows',
      strategy: baselineStrategy
        ? `catalog_${local.strategy}+${baselineStrategy}`
        : `catalog_${local.strategy}`,
      reason: local.reason,
    };
  }

  if (result?.prompt && body.workflow_id && !hadBaselineRun) {
    baseline = 'missing';
    baselineReason =
      'No trusted baseline found — Run + Publish in the Floyo editor to create one.';
    blockCategory = 'unverified';
  }

  // 4. File check on the catalog prompt (#inputs + #community_inputs).
  // Only applied when baseline would otherwise allow queue (exact/unknown).
  if (result?.prompt && (baseline === 'exact' || baseline === 'unknown')) {
    const fileBlock = await checkPromptFilesBlock(result.prompt);
    if (fileBlock) {
      baseline = fileBlock.baseline;
      baselineReason = fileBlock.reason;
      blockCategory = fileBlock.category;
    }
  }

  const trusted = baseline === 'exact';
  const response = {
    success: !!result?.prompt && isApiPromptShape(result.prompt),
    prompt: result?.prompt ?? null,
    source: result?.source ?? 'none',
    strategy: result?.strategy,
    reason: baselineReason ?? result?.reason,
    baseline,
    trusted,
    category: blockCategory,
    mode: BASELINE_MODE,
    cached: false,
  };

  // Do not cache "missing baseline" from empty catalog — often a transient DB miss under load.
  const suspiciousMissing =
    baseline === 'missing' && result?.source === 'workflows' && !!body.workflow_id && !catalog.prompt;

  if (response.success && !suspiciousMissing) {
    const ttlMs = trusted ? 10 * 60 * 1000 : 5 * 60 * 1000;
    cacheSet(key, response, ttlMs, {
      workflowId: body.workflow_id || null,
      status: trusted
        ? 'trusted'
        : baseline === 'outdated'
          ? 'outdated'
          : baseline === 'community_input_missing' || blockCategory === 'invalid_prompt_files'
            ? 'blocked'
            : 'blocked',
    });
  }

  return response;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = req.url?.split('?')[0];

  if (req.method === 'GET' && url === '/health') {
    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    let supabaseRef = 'not configured';
    try {
      supabaseRef = supabaseUrl ? new URL(supabaseUrl).hostname.split('.')[0] : 'not configured';
    } catch {
      supabaseRef = 'invalid url';
    }
    sendJson(res, 200, {
      ok: true,
      baselineMode: BASELINE_MODE,
      supabaseRef,
      cache: getStats(),
    });
    return;
  }

  if (req.method === 'GET' && url === '/cache/stats') {
    try {
      sendJson(res, 200, { ok: true, ...getStats() });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (req.method === 'POST' && url === '/cache/clear') {
    try {
      const cleared = cacheClear();
      sendJson(res, 200, { ok: true, cleared, message: 'Cache cleared' });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (req.method === 'POST' && url === '/cache/clear-workflow') {
    try {
      const body = await readBody(req);
      const { workflow_id: workflowId } = body;
      if (!workflowId) {
        sendJson(res, 400, { ok: false, error: 'workflow_id required' });
        return;
      }
      const cleared = clearByWorkflowId(workflowId);
      sendJson(res, 200, { ok: true, cleared });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (req.method === 'POST' && url === '/generate-prompt') {
    try {
      const body = await readBody(req);
      const result = await handleGeneratePrompt(body);
      sendJson(res, result.success ? 200 : 422, result);
    } catch (err) {
      sendJson(res, 400, { ok: false, success: false, error: err.message });
    }
    return;
  }

  sendJson(res, 404, { success: false, error: 'Not found' });
});

server.listen(PORT, HOST, () => {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  let supabaseRef = 'not configured';
  try {
    supabaseRef = supabaseUrl ? new URL(supabaseUrl).hostname.split('.')[0] : 'not configured';
  } catch {
    supabaseRef = 'invalid url';
  }
  console.log(`Floyo prompt service listening on http://${HOST}:${PORT}`);
  console.log(`  baseline mode: ${BASELINE_MODE}`);
  console.log(`  supabase ref: ${supabaseRef}`);
  console.log('  POST /generate-prompt     — build API prompt (read-only, no DB writes)');
  console.log('  GET  /health');
  console.log('  GET  /cache/stats');
  console.log('  POST /cache/clear');
  console.log('  POST /cache/clear-workflow');
});

