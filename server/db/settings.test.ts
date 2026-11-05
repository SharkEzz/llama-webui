import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./open";
import { SettingsRepo } from "./settings";
import { DEFAULT_SETTINGS } from "@llama-webui/shared";

test("settings: défauts puis patch persisté", () => {
  const dir = mkdtempSync(join(tmpdir(), "lw-"));
  const db = openDb(join(dir, "sub", "t.sqlite")); // sous-dossier inexistant
  const repo = new SettingsRepo(db);
  expect(repo.get()).toEqual(DEFAULT_SETTINGS);
  expect(repo.patch({ port: 9000 }).port).toBe(9000);
  expect(new SettingsRepo(db).get().port).toBe(9000);
  expect(() => repo.patch({ pollIntervalMs: 10 })).toThrow();
});

test("settings: une valeur stockée devenue invalide retombe sur le défaut et reste réparable", () => {
  const dir = mkdtempSync(join(tmpdir(), "lw-"));
  const db = openDb(join(dir, "t.sqlite"));
  db.run("INSERT INTO settings(key, value_json) VALUES ('port', '\"bad\"'), ('pollIntervalMs', '10')");
  const repo = new SettingsRepo(db);
  expect(repo.get().port).toBe(DEFAULT_SETTINGS.port);
  expect(repo.get().pollIntervalMs).toBe(DEFAULT_SETTINGS.pollIntervalMs);
  expect(repo.patch({ port: 9001 }).port).toBe(9001);
});
