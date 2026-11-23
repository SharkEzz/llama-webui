import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { copyDataDir, dataCopyOf, removeDataCopy, sourceDataDir } from './datadir.ts';
import { runDir } from './run-dir.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0).toReversed()) c();
});

const source = (dataDir: string | null, env: NodeJS.ProcessEnv, dotEnv: string | null = null) =>
  sourceDataDir(dataDir, env, dotEnv, '/repo', '/home/system');

test('--data-dir wins, then LLAMA_WEBUI_DATA_DIR, then XDG_DATA_HOME, then the home', () => {
  const env = { LLAMA_WEBUI_DATA_DIR: '/env/data', XDG_DATA_HOME: '/xdg', HOME: '/home/me' };
  expect(source('/flag', env)).toBe('/flag');
  expect(source(null, env)).toBe('/env/data');
  expect(source(null, { XDG_DATA_HOME: '/xdg', HOME: '/home/me' })).toBe('/xdg/llama-webui');
  expect(source(null, { HOME: '/home/me' })).toBe('/home/me/.local/share/llama-webui');
  expect(source(null, {})).toBe('/home/system/.local/share/llama-webui');
});

test('a relative path is read from the folder the server starts in, and an empty variable counts as unset', () => {
  expect(source('data', {})).toBe('/repo/data');
  expect(source(null, { LLAMA_WEBUI_DATA_DIR: 'data' })).toBe('/repo/data');
  expect(source(null, { LLAMA_WEBUI_DATA_DIR: '', HOME: '/home/me' })).toBe('/home/me/.local/share/llama-webui');
});

test('.env fills what the environment lacks, and wins only with LLAMA_WEBUI_ENV_OVERRIDE', () => {
  const dotEnv = 'LLAMA_WEBUI_DATA_DIR=/file/data\n';
  expect(source(null, { HOME: '/home/me' }, dotEnv)).toBe('/file/data');
  expect(source(null, { LLAMA_WEBUI_DATA_DIR: '/env/data' }, dotEnv)).toBe('/env/data');
  expect(source(null, { LLAMA_WEBUI_DATA_DIR: '/env/data', LLAMA_WEBUI_ENV_OVERRIDE: '1' }, dotEnv)).toBe('/file/data');
  expect(source(null, { LLAMA_WEBUI_DATA_DIR: '/env/data' }, `${dotEnv}LLAMA_WEBUI_ENV_OVERRIDE=True\n`)).toBe(
    '/file/data',
  );
  // An empty variable of the environment is defined: .env does not fill it, and it counts as unset.
  expect(source(null, { LLAMA_WEBUI_DATA_DIR: '', HOME: '/home/me' }, dotEnv)).toBe(
    '/home/me/.local/share/llama-webui',
  );
});

function tempRun() {
  const run = runDir(`.datadir-test-${String(process.pid)}-${String(cleanups.length)}`);
  mkdirSync(run.path, { recursive: true });
  cleanups.push(() => rmSync(run.path, { recursive: true, force: true }));
  return run;
}

test('a run copies the data directory, the source untouched, and removes its copy', () => {
  const from = mkdtempSync(join(tmpdir(), 'profiling-datadir-'));
  cleanups.push(() => rmSync(from, { recursive: true, force: true }));
  writeFileSync(join(from, 'llama-webui.sqlite'), 'data');
  const run = tempRun();
  const copy = copyDataDir(run, from);
  expect(copy).toBe(dataCopyOf(run));
  expect(run.readState().dataCopy).toBe(true);
  writeFileSync(join(copy, 'llama-webui.sqlite'), 'migrated');
  expect(readFileSync(join(from, 'llama-webui.sqlite'), 'utf8')).toBe('data');
  removeDataCopy(run);
  expect(existsSync(copy)).toBe(false);
  expect(existsSync(join(from, 'llama-webui.sqlite'))).toBe(true);
});

test('a data directory that does not exist yet is copied as an empty one', () => {
  const run = tempRun();
  const copy = copyDataDir(run, join(tmpdir(), `profiling-no-such-dir-${String(process.pid)}`));
  expect(existsSync(copy)).toBe(true);
});
