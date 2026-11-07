import { expect, test } from 'bun:test';
import { DEFAULT_HOST, DEFAULT_PORT, parseCli } from './cli';

test('parseCli: defaults without flag or env', () => {
  expect(parseCli([], {})).toEqual({ kind: 'run', options: { host: DEFAULT_HOST, port: DEFAULT_PORT } });
});

test('parseCli: environment variables', () => {
  const env = { LLAMA_WEBUI_HOST: '0.0.0.0', LLAMA_WEBUI_PORT: '8080', LLAMA_WEBUI_DATA_DIR: '/tmp/d' };
  expect(parseCli([], env)).toEqual({ kind: 'run', options: { host: '0.0.0.0', port: 8080, dataDir: '/tmp/d' } });
});

test('parseCli: a flag overrides the env, --opt=val form accepted', () => {
  const env = { LLAMA_WEBUI_HOST: '0.0.0.0', LLAMA_WEBUI_PORT: '8080', LLAMA_WEBUI_DATA_DIR: '/tmp/d' };
  expect(parseCli(['--host', '192.168.0.20', '--port=9000', '--data-dir', '/srv/x'], env)).toEqual({
    kind: 'run',
    options: { host: '192.168.0.20', port: 9000, dataDir: '/srv/x' },
  });
});

test('parseCli: empty env ignored (as before)', () => {
  expect(parseCli([], { LLAMA_WEBUI_HOST: '', LLAMA_WEBUI_PORT: '', LLAMA_WEBUI_DATA_DIR: '' })).toEqual({
    kind: 'run',
    options: { host: DEFAULT_HOST, port: DEFAULT_PORT },
  });
});

test('parseCli: --help and -h', () => {
  expect(parseCli(['--help'], {})).toEqual({ kind: 'help' });
  expect(parseCli(['-h', '--port', 'nope'], {})).toEqual({ kind: 'help' });
});

test('parseCli: invalid port (flag or env)', () => {
  for (const p of ['0', '65536', 'abc', '80.5', '-1', '']) {
    const r = parseCli([`--port=${p}`], {});
    expect(r.kind).toBe('error');
  }
  const r = parseCli([], { LLAMA_WEBUI_PORT: 'x' });
  expect(r).toEqual({ kind: 'error', message: expect.stringContaining('LLAMA_WEBUI_PORT') });
});

test('parseCli: unknown option, missing value, positional, empty value', () => {
  expect(parseCli(['--nope'], {}).kind).toBe('error');
  expect(parseCli(['--port'], {}).kind).toBe('error');
  expect(parseCli(['serve'], {}).kind).toBe('error');
  expect(parseCli(['--host='], {}).kind).toBe('error');
  expect(parseCli(['--data-dir='], {}).kind).toBe('error');
});
