import { expect, test } from 'bun:test';
import { BenchSpecSchema, SweepSpecSchema } from '@llama-webui/shared';
import { BenchRunsRepo } from './benchRuns';
import { openDb } from './open';
import { ProfilesRepo } from './profiles';
import { SweepsRepo } from './sweeps';

test('a run whose profile no longer exists is created without it', () => {
  const repo = new BenchRunsRepo(openDb(':memory:'));
  const run = repo.create(BenchSpecSchema.parse({ kind: 'bench', modelPath: '/m/a.gguf', profileId: 42 }), 'cmd', {
    cpu: '',
    gpus: [],
    build: null,
  });
  expect(run.spec.profileId).toBeNull();
});

test('lastOkByProfile: the latest successful one-off run per profile; failures, sweep items and orphans ignored', () => {
  let t = 1000;
  const db = openDb(':memory:');
  const runs = new BenchRunsRepo(db, () => t++);
  const profiles = new ProfilesRepo(db);
  const a = profiles.create({ name: 'a', model: '/m/a.gguf', args: [], env: {} });
  const b = profiles.create({ name: 'b', model: '/m/b.gguf', args: [], env: {} });
  const c = profiles.create({ name: 'c', model: '/m/c.gguf', args: [], env: {} });
  const hw = { cpu: '', gpus: [], build: null };
  const run = (profileId: number | null, status: 'ok' | 'failed', tg: number) => {
    const r = runs.create(BenchSpecSchema.parse({ kind: 'bench', modelPath: '/m/x.gguf', profileId }), 'cmd', hw);
    return runs.finish(r.id, { status, tg: { tps: tg, stddev: 0, tokens: 128 } });
  };
  run(a.id, 'ok', 10);
  const latestA = run(a.id, 'ok', 20);
  run(a.id, 'failed', 30);
  run(b.id, 'failed', 40);
  run(null, 'ok', 50);
  const sweeps = new SweepsRepo(db);
  const s = sweeps.create(
    SweepSpecSchema.parse({
      name: 's',
      modelPath: '/m/c.gguf',
      profileId: c.id,
      preset: 'chat',
      space: { ncmoe: [0] },
    }),
  );
  const [item] = runs.enqueue(s.id, [
    {
      spec: BenchSpecSchema.parse({ kind: 'bench', modelPath: '/m/c.gguf', profileId: c.id }),
      label: '-ncmoe 0',
      fit: 'fits',
    },
  ]);
  runs.finish(item!.id, { status: 'ok', tg: { tps: 60, stddev: 0, tokens: 128 } });

  const last = runs.lastOkByProfile();
  expect([...last.keys()]).toEqual([a.id]);
  expect(last.get(a.id)!.id).toBe(latestA.id);
  expect(last.get(a.id)!.tg!.tps).toBe(20);
});
