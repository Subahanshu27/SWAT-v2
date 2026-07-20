import 'server-only';

/** One active preflight per batch — duplicate clicks/tabs share the same run. */
const inFlight = new Map<string, Promise<unknown>>();

export function coalescePreflight<T>(batchId: string, run: () => Promise<T>): Promise<T> {
  const key = `preflight:${batchId}`;
  const existing = inFlight.get(key);
  if (existing) {
    console.log(`[SWAT preflight] batch ${batchId} — duplicate request joined in-flight run`);
    return existing as Promise<T>;
  }

  const promise = run().finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}
