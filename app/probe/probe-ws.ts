// S0.2: hello, 5000-byte frame (maxPayload), upgrade refused for a foreign Origin.
const url = process.env.WS_URL ?? 'ws://192.168.0.20:7870/ws';
const run = (label: string, init: { headers?: Record<string, string> }, payload?: string) =>
  new Promise<void>((resolve) => {
    const ws = new WebSocket(url, init as never);
    const t = setTimeout(() => { console.log(label, 'timeout'); ws.close(); resolve(); }, 3000);
    ws.onopen = () => { console.log(label, 'open'); if (payload) ws.send(payload); };
    ws.onmessage = (e) => { console.log(label, 'message', String(e.data)); if (!payload || String(e.data).includes('echo')) ws.close(1000); };
    ws.onerror = (e) => console.log(label, 'error', (e as ErrorEvent).message ?? e.type);
    ws.onclose = (e) => { clearTimeout(t); console.log(label, 'close', e.code, e.reason); resolve(); };
  });
await run('hello', {});
await run('big', {}, 'x'.repeat(5000));
await run('huge', {}, 'x'.repeat(2_000_000));
await run('evil', { headers: { origin: 'http://evil.example' } });
