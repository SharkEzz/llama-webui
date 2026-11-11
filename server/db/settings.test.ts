import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { DEFAULT_SETTINGS } from '@llama-webui/shared';
import { tempDir } from '../testing/tempDir';
import { openDb } from './open';
import { SettingsRepo } from './settings';

test('settings: defaults, then a persisted patch', () => {
  using dir = tempDir('lw-');
  using db = openDb(join(dir.path, 'sub', 't.sqlite')); // missing subdirectory
  const repo = new SettingsRepo(db);
  expect(repo.get()).toEqual(DEFAULT_SETTINGS);
  expect(repo.patch({ port: 9000 }).port).toBe(9000);
  expect(new SettingsRepo(db).get().port).toBe(9000);
  expect(() => repo.patch({ pollIntervalMs: 10 })).toThrow();
});

test('settings: a stored value that became invalid falls back to the default and can be repaired', () => {
  using dir = tempDir('lw-');
  using db = openDb(join(dir.path, 't.sqlite'));
  db.run("INSERT INTO settings(key, value_json) VALUES ('port', '\"bad\"'), ('pollIntervalMs', '10')");
  const repo = new SettingsRepo(db);
  expect(repo.get().port).toBe(DEFAULT_SETTINGS.port);
  expect(repo.get().pollIntervalMs).toBe(DEFAULT_SETTINGS.pollIntervalMs);
  expect(repo.patch({ port: 9001 }).port).toBe(9001);
});

test('settings: llama-server listens on loopback by default, like llama-webui (#27)', () => {
  using db = openDb(':memory:');
  expect(new SettingsRepo(db).get().host).toBe('127.0.0.1');
});

test('settings: env is replaced as a whole (a variable left out is removed) and its names are checked', () => {
  using dir = tempDir('lw-');
  using db = openDb(join(dir.path, 't.sqlite'));
  const repo = new SettingsRepo(db);
  repo.patch({ env: { A: '1', B: '2' } });
  expect(repo.patch({ env: { B: '3' } }).env).toEqual({ B: '3' });
  expect(new SettingsRepo(db).get().env).toEqual({ B: '3' });
  expect(() => repo.patch({ env: { '1BAD': 'x' } })).toThrow('invalid variable name “1BAD”');
});
