import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, test } from 'vitest';
import { loadDotEnv, useEnvProxy } from './env';
import { tempDir } from './testing/tempDir';
import { writeFileDeep } from './testing/write';

const KEYS = ['LW_ENV_A', 'LW_ENV_B', 'LLAMA_WEBUI_ENV_OVERRIDE'];
afterEach(() => {
  for (const k of KEYS) delete process.env[k];
});

async function load(file: string, override?: boolean): Promise<(string | undefined)[]> {
  using dir = tempDir('lw-env-');
  await writeFileDeep(`${dir.path}/.env`, file);
  process.env.LW_ENV_B = 'from-env';
  loadDotEnv(`${dir.path}/.env`, { override });
  return [process.env.LW_ENV_A, process.env.LW_ENV_B];
}

test('loadDotEnv: the file fills what the environment lacks, a variable already set wins', async () => {
  expect(await load('LW_ENV_A=from-file\nLW_ENV_B=from-file\n')).toEqual(['from-file', 'from-env']);
});

test('loadDotEnv: { override: true } (--env-override) lets the file override the environment', async () => {
  expect(await load('LW_ENV_B=from-file\n', true)).toEqual([undefined, 'from-file']);
});

test('loadDotEnv: LLAMA_WEBUI_ENV_OVERRIDE=1 in the environment lets the file override it', async () => {
  process.env.LLAMA_WEBUI_ENV_OVERRIDE = '1';
  expect(await load('LW_ENV_A=from-file\nLW_ENV_B=from-file\n')).toEqual(['from-file', 'from-file']);
});

test('loadDotEnv: LLAMA_WEBUI_ENV_OVERRIDE=true in the file itself lets it override the environment', async () => {
  expect(await load('LLAMA_WEBUI_ENV_OVERRIDE=true\nLW_ENV_B=from-file\n')).toEqual([undefined, 'from-file']);
});

test('loadDotEnv: LLAMA_WEBUI_ENV_OVERRIDE=0 keeps the environment', async () => {
  process.env.LLAMA_WEBUI_ENV_OVERRIDE = '0';
  expect(await load('LW_ENV_B=from-file\n')).toEqual([undefined, 'from-env']);
});

test('loadDotEnv: no file, nothing happens', () => {
  using dir = tempDir('lw-env-');
  expect(() => loadDotEnv(`${dir.path}/.env`)).not.toThrow();
});

async function serve(reply: (req: IncomingMessage) => string): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => res.end(reply(req)));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

test('useEnvProxy: no proxy variable, nothing changes', () => {
  expect(useEnvProxy({ NO_PROXY: 'example.com' })).toBeNull();
  expect(useEnvProxy({ HTTPS_PROXY: '' })).toBeNull();
});

test('useEnvProxy: fetch goes through HTTP_PROXY, except for loopback and the hosts of NO_PROXY', async () => {
  const proxy = await serve((req) => `proxy ${req.url}`);
  const local = await serve(() => 'direct');
  const servers = [proxy.server, local.server];
  const text = (url: string) =>
    fetch(url).then(
      (r) => r.text(),
      () => 'unreachable',
    );
  try {
    // Without it, Node's fetch ignores the variable.
    process.env.HTTP_PROXY = proxy.url;
    expect(await text('http://hub.invalid/api/models')).toBe('unreachable');
    const restore = useEnvProxy({ HTTP_PROXY: proxy.url, NO_PROXY: 'skipped.invalid' });
    try {
      expect(await text('http://hub.invalid/api/models')).toBe('proxy http://hub.invalid/api/models');
      expect(await text(`${local.url}/health`)).toBe('direct');
      expect(await text('http://skipped.invalid/')).toBe('unreachable');
    } finally {
      restore?.();
    }
    expect(await text('http://hub.invalid/api/models')).toBe('unreachable');
  } finally {
    delete process.env.HTTP_PROXY;
    for (const s of servers) {
      s.closeAllConnections();
      await new Promise((r) => s.close(r));
    }
  }
});
