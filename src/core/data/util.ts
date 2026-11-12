/** Small helpers shared by the data loaders. Pure TS, no DOM / Node APIs. */

/** Runs `fn` over `items` with at most `limit` in flight. Never rejects; fn must handle its own errors. */
export async function runPool<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i], i);
    }
  };
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, worker));
}

/** True when an error from FetchBytes looks like an HTTP 404 / missing object. */
export function isNotFound(err: unknown): boolean {
  const e = err as { status?: number; statusCode?: number; message?: string } | null;
  if (!e) return false;
  if (e.status === 404 || e.statusCode === 404) return true;
  const msg = String(e.message ?? err);
  return /\b404\b|NoSuchKey|not found/i.test(msg);
}
