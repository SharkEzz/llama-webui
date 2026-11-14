import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelDeleted, ModelUsage } from '@llama-webui/shared';
import { expect, test } from 'vitest';
import remove from '../../routes/api/models/index.delete.ts';
import usageRoute from '../../routes/api/models/usage.get.ts';
import { provideDeps } from '../context';
import { openDb } from '../db/open';
import { ProfilesRepo } from '../db/profiles';
import { SettingsRepo } from '../db/settings';
import type { AppDeps } from '../deps';
import { routeApp } from '../testing/routes';
import { tempDir } from '../testing/tempDir';

/** A models folder holding unreadable `.gguf` files: the scan lists them (ok: false), which is enough to delete. */
function setup() {
  const tmp = tempDir('lw-models-');
  const models = join(tmp.path, 'models');
  mkdirSync(join(models, 'org', 'Big'), { recursive: true });
  const big = [1, 2].map((i) => join(models, 'org', 'Big', `Big-0000${i}-of-00002.gguf`));
  for (const f of big) writeFileSync(f, 'x');
  writeFileSync(join(models, 'small.gguf'), 'x');
  writeFileSync(join(models, 'mm.gguf'), 'x');
  const db = openDb(join(tmp.path, 't.sqlite'));
  const settings = new SettingsRepo(db);
  settings.patch({ modelsDir: models });
  const profiles = new ProfilesRepo(db);
  const state = { active: null as number | null, benchModel: null as string | null };
  const provided = provideDeps({
    db,
    settings,
    profiles,
    activeProfileId: () => state.active,
    benchRunner: {
      get live() {
        return state.benchModel ? ({ runId: 1 } as never) : null;
      },
    },
    benchRuns: { get: () => ({ spec: { modelPath: state.benchModel, mmprojPath: null } }) as never },
    sweeps: { running: () => null },
    downloadsRepo: { active: () => [] },
  } as unknown as AppDeps);
  const app = routeApp([
    ['GET', '/api/models/usage', usageRoute],
    ['DELETE', '/api/models', remove],
  ]);
  const usage = async (path: string) => {
    const r = await app.request(`/api/models/usage?path=${encodeURIComponent(path)}`);
    return { status: r.status, body: (await r.json()) as ModelUsage & { error?: string } };
  };
  const del = async (path: string, deleteProfiles: boolean) => {
    const r = await app.request('/api/models', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, deleteProfiles }),
    });
    return { status: r.status, body: (await r.json()) as ModelDeleted & { error?: string; code?: string } };
  };
  return {
    models,
    big,
    profiles,
    settings,
    state,
    usage,
    remove: del,
    [Symbol.dispose]: () => {
      provided[Symbol.dispose]();
      db.close();
      tmp[Symbol.dispose]();
    },
  };
}

test('deleting a split model removes every part and the folders left empty, not the models folder', async () => {
  using s = setup();
  const r = await s.remove(s.big[0]!, false);
  expect(r.status).toBe(200);
  expect(r.body).toEqual({ deletedFiles: s.big, deletedProfiles: [] });
  expect(s.big.some((f) => existsSync(f))).toBe(false);
  expect(existsSync(join(s.models, 'org'))).toBe(false);
  expect(existsSync(join(s.models, 'small.gguf'))).toBe(true);
});

test('only a model the scan found can be deleted: another path is a 404', async () => {
  using s = setup();
  const outside = join(s.models, '..', 'outside.gguf');
  writeFileSync(outside, 'x');
  expect((await s.remove(outside, false)).status).toBe(404);
  expect((await s.remove(s.big[1]!, false)).status).toBe(404); // a later part is not an entry
  expect((await s.usage('/etc/passwd')).status).toBe(404);
  expect(existsSync(outside)).toBe(true);
});

test('usage lists the profiles opening the file as model or projector, through a relative path or a symlink', async () => {
  using s = setup();
  symlinkSync(s.models, join(s.models, '..', 'link'));
  const a = s.profiles.create({ name: 'A', cwd: s.models, model: 'small.gguf', args: [], env: {} });
  const b = s.profiles.create({ name: 'B', model: join(s.models, '..', 'link', 'small.gguf'), args: [], env: {} });
  const c = s.profiles.create({ name: 'C', cwd: s.models, model: 'mm.gguf', mmproj: 'small.gguf', args: [], env: {} });
  s.profiles.create({ name: 'D', cwd: s.models, model: 'mm.gguf', args: [], env: {} });
  const r = await s.usage(join(s.models, 'small.gguf'));
  expect(r.status).toBe(200);
  expect(r.body.profiles).toEqual([
    { id: a.id, name: 'A', role: 'model' },
    { id: b.id, name: 'B', role: 'model' },
    { id: c.id, name: 'C', role: 'mmproj' },
  ]);
  expect(r.body.blocked).toBeNull();
});

test('deleteProfiles deletes the profiles using the model and resets the default; false keeps them', async () => {
  using s = setup();
  const a = s.profiles.create({ name: 'A', cwd: s.models, model: 'small.gguf', args: [], env: {} });
  const b = s.profiles.create({ name: 'B', cwd: s.models, model: 'mm.gguf', args: [], env: {} });
  s.settings.patch({ defaultProfileId: a.id });
  const r = await s.remove(join(s.models, 'small.gguf'), true);
  expect(r.body.deletedProfiles).toEqual([a.id]);
  expect(s.profiles.list().map((p) => p.id)).toEqual([b.id]);
  expect(s.settings.get().defaultProfileId).toBeNull();

  expect((await s.remove(join(s.models, 'mm.gguf'), false)).body.deletedProfiles).toEqual([]);
  expect(s.profiles.get(b.id)).not.toBeNull();
});

test('a model the running server or a benchmark uses is a 409, and nothing is deleted', async () => {
  using s = setup();
  const a = s.profiles.create({ name: 'A', cwd: s.models, model: 'mm.gguf', mmproj: 'small.gguf', args: [], env: {} });
  s.state.active = a.id;
  const small = join(s.models, 'small.gguf');
  expect((await s.usage(small)).body.blocked).toContain('running server');
  const r = await s.remove(small, true);
  expect(r.status).toBe(409);
  expect(r.body.code).toBe('model-in-use');
  expect(existsSync(small)).toBe(true);
  expect(s.profiles.get(a.id)).not.toBeNull();

  s.state.active = null;
  s.state.benchModel = small;
  expect((await s.remove(small, false)).status).toBe(409);
  s.state.benchModel = null;
  expect((await s.remove(small, false)).status).toBe(200);
});
