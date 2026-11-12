import { afterEach, expect, test } from 'vitest';
import { loadDotEnv } from './env';
import { tempDir } from './testing/tempDir';
import { writeFileDeep } from './testing/write';

const KEYS = ['LW_ENV_A', 'LW_ENV_B'];
afterEach(() => {
  for (const k of KEYS) delete process.env[k];
});

test('loadDotEnv: the file sets its variables and overrides those already in the environment', async () => {
  using dir = tempDir('lw-env-');
  await writeFileDeep(`${dir.path}/.env`, 'LW_ENV_A=from-file\nLW_ENV_B=from-file\n');
  process.env.LW_ENV_B = 'from-env';
  loadDotEnv(`${dir.path}/.env`);
  expect([process.env.LW_ENV_A, process.env.LW_ENV_B]).toEqual(['from-file', 'from-file']);
});

test('loadDotEnv: no file, nothing happens', () => {
  using dir = tempDir('lw-env-');
  expect(() => loadDotEnv(`${dir.path}/.env`)).not.toThrow();
});
