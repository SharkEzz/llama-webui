import { afterAll, expect, test } from 'bun:test';
import { probeLlamaServer, probeUrl } from './health';

test('probeUrl reaches a wildcard address on loopback and a specific one as is (#28)', () => {
  expect(probeUrl('0.0.0.0', 8080)).toBe('http://127.0.0.1:8080');
  expect(probeUrl(undefined, 8080)).toBe('http://127.0.0.1:8080');
  expect(probeUrl('192.168.0.20', 8080)).toBe('http://192.168.0.20:8080');
  expect(probeUrl('::', 8080)).toBe('http://[::1]:8080');
  expect(probeUrl('fe80::1', 8080)).toBe('http://[fe80::1]:8080');
  expect(probeUrl('[::1]', 8080)).toBe('http://[::1]:8080');
});

// One fake server per answer: llama-server loaded, loading, and an unrelated web server.
const servers = [
  Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json({ status: 'ok' }) }),
  Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () =>
      Response.json({ error: { code: 503, message: 'Loading model', type: 'unavailable_error' } }, { status: 503 }),
  }),
  Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('<h1>Not Found</h1>', { status: 404 }) }),
];
afterAll(() => {
  for (const s of servers) s.stop(true);
});

test('only a service answering like llama-server counts as an external llama-server (#28)', async () => {
  const [ok, loading, other] = servers.map((s) => s.port!);
  expect(await probeLlamaServer(ok!)).toBe(true);
  expect(await probeLlamaServer(loading!)).toBe(true);
  expect(await probeLlamaServer(other!)).toBe(false);
});
