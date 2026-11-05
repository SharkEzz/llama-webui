const PROBE_TIMEOUT_MS = 800;

/**
 * The status llama-server's /health answers on 127.0.0.1:`port` (200 once loaded, 503 while loading), or null
 * when nothing answers within 800 ms. Shared by the Supervisor and the benchmark: one rule for "a server is
 * on the port" and one for "it is ready".
 */
export async function probeHealth(port: number, fetchImpl: typeof fetch = fetch): Promise<number | null> {
  try {
    const r = await fetchImpl(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    await r.body?.cancel().catch(() => {});
    return r.status;
  } catch {
    return null;
  }
}
