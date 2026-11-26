// Talks to the local Decltr server. The extension never sees the Gemini key.

export const SERVER_URL = 'http://127.0.0.1:47821';

export class ApiError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

async function post(path, body, timeoutMs, signal) {
  let res;
  try {
    const deadline = AbortSignal.timeout(timeoutMs);
    res = await fetch(`${SERVER_URL}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal && AbortSignal.any ? AbortSignal.any([signal, deadline]) : deadline,
    });
  } catch (err) {
    if (signal?.aborted) throw new ApiError('aborted', 'Stopped.');
    if (err?.name === 'TimeoutError') {
      throw new ApiError('timeout', 'That took too long. Please try again.');
    }
    throw new ApiError('offline', 'Cannot reach the Decltr server.');
  }
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.ok) {
    throw new ApiError(json?.error?.code ?? 'error', json?.error?.message ?? `Server error (${res.status}).`, res.status);
  }
  return json;
}

/** Server features this version of the extension relies on. */
export const REQUIRED_FEATURES = ['plan', 'name', 'control'];

export const checkHealth = () => post('/v1/health', {}, 3000);

/** Ask the background service to restart or stop. Only works when the server runs as that service. */
export const controlServer = (action) => post('/v1/control', { action }, 5000);

/** True if the server reports every feature the extension needs. An old server reports none. */
export const serverIsCurrent = (info) => REQUIRED_FEATURES.every((f) => info?.features?.includes(f));
export const requestPlan = (payload, { signal } = {}) => post('/v1/plan', payload, 60_000, signal);

/** Ask the server for a short name for a set of tabs. Tabs: [{ title, url, group? }]. */
export async function suggestName(tabs) {
  try {
    return (await post('/v1/name', { tabs }, 20_000)).name;
  } catch (err) {
    // An old server that was never restarted does not know this endpoint.
    if (err instanceof ApiError && err.code === 'not_found') {
      throw new ApiError('outdated', 'The Decltr server is running an older version that cannot name sessions. Restart it to update it.', err.status);
    }
    throw err;
  }
}
