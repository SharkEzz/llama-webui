import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { DEFAULT_SETTINGS } from '@llama-webui/shared';
import { tempDir } from '../testing/tempDir';
import { openDb } from './open';
import { SettingsRepo } from './settings';

test('settings: défauts puis patch persisté', () => {
  using dir = tempDir('lw-');
  using db = openDb(join(dir.path, 'sub', 't.sqlite')); // sous-dossier inexistant
  const repo = new SettingsRepo(db);
  expect(repo.get()).toEqual(DEFAULT_SETTINGS);
  expect(repo.patch({ port: 9000 }).port).toBe(9000);
  expect(new SettingsRepo(db).get().port).toBe(9000);
  expect(() => repo.patch({ pollIntervalMs: 10 })).toThrow();
});

test('settings: une valeur stockée devenue invalide retombe sur le défaut et reste réparable', () => {
  using dir = tempDir('lw-');
  using db = openDb(join(dir.path, 't.sqlite'));
  db.run("INSERT INTO settings(key, value_json) VALUES ('port', '\"bad\"'), ('pollIntervalMs', '10')");
  const repo = new SettingsRepo(db);
  expect(repo.get().port).toBe(DEFAULT_SETTINGS.port);
  expect(repo.get().pollIntervalMs).toBe(DEFAULT_SETTINGS.pollIntervalMs);
  expect(repo.patch({ port: 9001 }).port).toBe(9001);
});
