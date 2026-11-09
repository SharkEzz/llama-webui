const PROBE_TIMEOUT_MS = 800;

/**
 * Base URL to reach a llama-server listening on `host`:`port` from this machine. A wildcard address (`0.0.0.0`, `::`)
 * or none means loopback; a specific address (a LAN IP) is used as is, since llama-server then refuses loopback
 * connections (#28). IPv6 addresses get their brackets.
 */
export function probeUrl(host: string | null | undefined, port: number): string {
  const h = (host ?? '').trim().replace(/^\[|\]$/g, '');
  const target = h === '' || h === '0.0.0.0' ? '127.0.0.1' : h === '::' ? '::1' : h;
  return `http://${target.includes(':') ? `[${target}]` : target}:${port}`;
}

/**
 * The status llama-server's /health answers on `host`:`port` (200 once loaded, 503 while loading), or null
 * when nothing answers within 800 ms. Shared by the Supervisor and the benchmark: one rule for "a server is
 * on the port" and one for "it is ready".
 */
export async function probeHealth(
  port: number,
  fetchImpl: typeof fetch = fetch,
  host?: string | null,
): Promise<number | null> {
  try {
    const r = await fetchImpl(`${probeUrl(host, port)}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    await r.body?.cancel().catch(() => {});
    return r.status;
  } catch {
    return null;
  }
}

/**
 * True when the service on the port is a llama-server: its /health answers JSON, `{"status":"ok"}` once loaded or
 * `{"error":{"type":"unavailable_error",…}}` while loading. Any other HTTP service (a web server, another API) is not
 * an external llama-server (#28).
 */
export async function probeLlamaServer(
  port: number,
  fetchImpl: typeof fetch = fetch,
  host?: string | null,
): Promise<boolean> {
  try {
    const r = await fetchImpl(`${probeUrl(host, port)}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    const body = (await r.json().catch(() => null)) as { status?: unknown; error?: { type?: unknown } } | null;
    if (!body || typeof body !== 'object') return false;
    return typeof body.status === 'string' || body.error?.type === 'unavailable_error';
  } catch {
    return false;
  }
}
