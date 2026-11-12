import { afterEach, expect, test } from 'vitest';
import { loadDotEnv } from './env';
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
