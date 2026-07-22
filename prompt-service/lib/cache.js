/** Simple in-memory TTL cache so repeated preflight/queue calls stay fast. */

const store = new Map();
const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

let hits = 0;
let misses = 0;

function deriveStatus(value) {
  if (!value || typeof value !== 'object') return 'unknown';
  if (
    value.category === 'community_input_missing' ||
    value.category === 'invalid_prompt_files' ||
    value.baseline === 'community_input_missing'
  ) {
    return 'blocked';
  }
  if (value.trusted || value.baseline === 'exact') return 'trusted';
  if (value.baseline === 'outdated') return 'outdated';
  if (value.baseline === 'stale' || value.baseline === 'missing') return 'blocked';
  return 'unknown';
}

export function cacheGet(key) {
  const entry = store.get(key);
  if (!entry) {
    misses++;
    return null;
  }
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    misses++;
    return null;
  }
  hits++;
  return entry.value;
}

export function cacheSet(key, value, ttlMs = DEFAULT_TTL_MS, meta = {}) {
  store.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
    created: Date.now(),
    workflowId: meta.workflowId || null,
    status: meta.status || deriveStatus(value),
  });
}

export function cacheClear() {
  const size = store.size;
  store.clear();
  return size;
}

export function clearByWorkflowId(workflowId) {
  if (!workflowId) return 0;
  let cleared = 0;
  for (const [key, entry] of store.entries()) {
    if (entry.workflowId === workflowId || key.includes(workflowId)) {
      store.delete(key);
      cleared++;
    }
  }
  return cleared;
}

export function getStats() {
  const now = Date.now();
  const entries = [];

  for (const [key, entry] of store.entries()) {
    entries.push({
      key,
      status: entry.status,
      workflowId: entry.workflowId,
      created: entry.created,
      age_ms: now - entry.created,
    });
  }

  const totalEntries = entries.length;
  const blockedCount = entries.filter((e) => e.status === 'blocked').length;
  const trustedCount = entries.filter((e) => e.status === 'trusted').length;
  const outdatedCount = entries.filter((e) => e.status === 'outdated').length;
  const oldestAgeMin =
    totalEntries > 0 ? Math.round(Math.max(...entries.map((e) => e.age_ms)) / 60000) : 0;
  const newestAgeMin =
    totalEntries > 0 ? Math.round(Math.min(...entries.map((e) => e.age_ms)) / 60000) : 0;

  return {
    total_entries: totalEntries,
    trusted_count: trustedCount,
    blocked_count: blockedCount,
    outdated_count: outdatedCount,
    oldest_entry_age_min: oldestAgeMin,
    newest_entry_age_min: newestAgeMin,
    ttl_trusted_min: 10,
    ttl_blocked_min: 5,
    cache_hits: hits,
    cache_misses: misses,
    hit_rate_pct: hits + misses > 0 ? Math.round((hits / (hits + misses)) * 100) : 0,
  };
}

/** @deprecated use getStats */
export function cacheStats() {
  const stats = getStats();
  return { size: stats.total_entries, hits: stats.cache_hits, misses: stats.cache_misses };
}
