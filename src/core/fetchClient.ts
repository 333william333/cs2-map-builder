import type { FetchBytes } from './types';

/** FetchBytes implementation that goes through the local caching proxy (`/api/fetch`). */
export const proxyFetch: FetchBytes = async (url, opts) => {
  const method = opts?.method ?? 'GET';
  const res = await fetch(`/api/fetch?url=${encodeURIComponent(url)}`, {
    method,
    headers: opts?.headers,
    body: method === 'POST' ? opts?.body : undefined,
  });
  if (!res.ok) {
    throw new Error(`proxyFetch ${method} ${url} failed: HTTP ${res.status} ${res.statusText}`);
  }
  return new Uint8Array(await res.arrayBuffer());
};
