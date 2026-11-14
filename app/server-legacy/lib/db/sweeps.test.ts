import { join } from 'node:path';
import { type BenchSpec, BenchSpecSchema, SweepSpecSchema } from '@llama-webui/shared';
import { expect, test } from 'vitest';
import { tempDir } from '../testing/tempDir';
import { BenchRunsRepo } from './benchRuns';
import { MIGRATIONS, runMigrations } from './migrations';
import { openDb } from './open';
import { Database } from './sqlite';
import { SweepsRepo } from './sweeps';

const hw = { cpu: '', gpus: [], build: null };
const spec = BenchSpecSchema.parse({ kind: 'bench', modelPath: '/m/a.gguf' });
const sweepSpec = SweepSpecSchema.parse({
  name: 's',
  modelPath: '/m/a.gguf',
  preset: 'chat',
  space: { ncmoe: [0, 8, 16] },
});
const items = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    spec: { ...spec, params: { ncmoe: i } } as BenchSpec,
    label: `-ncmoe ${i}`,
    fit: 'fits' as const,
  }));

test("a deleted run's id is never handed out again", () => {
  const repo = new BenchRunsRepo(openDb(':memory:'));
  repo.create(spec, 'a', hw);
  const b = repo.create(spec, 'b', hw);
  repo.delete(b.id);
  expect(repo.create(spec, 'c', hw).id).toBeGreaterThan(b.id);
});

test('the migration keeps every run of a J5 database: ids, values and the next id', () => {
  using dir = tempDir('lw-mig-');
  const file = join(dir.path, 'db.sqlite');
  // A J5 database: the schema up to `bench_runs` and its index (8), before sweeps (9) and the AUTOINCREMENT rebuild.
  {
    using j5 = new Database(file);
    runMigrations(j5, 8);
    for (const [id, pp] of [
      [1, 100.5],
      [2, 200.5],
      [3, 300.5],
      [4, null],
    ] as const)
      j5.run(
        `INSERT INTO bench_runs(id, kind, status, model_path, args_json, command, hardware_json, pp_tps, vram_mib_json, created_at)
         VALUES (?, 'bench', ?, '/m/a.gguf', ?, 'cmd', ?, ?, '[]', ?)`,
        [id, pp === null ? 'failed' : 'ok', JSON.stringify(spec), JSON.stringify(hw), pp, id],
      );
    // A gap: the migration copies the ids, it does not renumber them.
    j5.run('DELETE FROM bench_runs WHERE id = 2');
  }

  using db = openDb(file);
  expect(db.query<{ version: number }, []>('SELECT version FROM schema_version').get()!.version).toBe(
    MIGRATIONS.length,
  );
  expect(db.query('SELECT id, status, pp_tps FROM bench_runs ORDER BY id').all()).toEqual([
    { id: 1, status: 'ok', pp_tps: 100.5 },
    { id: 3, status: 'ok', pp_tps: 300.5 },
    { id: 4, status: 'failed', pp_tps: null },
  ]);
  const repo = new BenchRunsRepo(db);
  expect(
    repo
      .list({ sweepId: 'all', limit: 1000 })
      .map((r) => r.id)
      .sort((a, b) => a - b),
  ).toEqual([1, 3, 4]);
  // Ids now come from AUTOINCREMENT, seeded by the copied rows: a deleted id is never handed out again.
  const next = repo.create(spec, 'x', hw);
  expect(next.id).toBe(5);
  repo.delete(next.id);
  expect(repo.create(spec, 'y', hw).id).toBe(6);
});

test('a sweep counts its queued items, cascades on delete and forgets a deleted best run', () => {
  const db = openDb(':memory:');
  const runs = new BenchRunsRepo(db);
  const sweeps = new SweepsRepo(db);
  const s = sweeps.create(sweepSpec);
  const queued = runs.enqueue(s.id, items(3));
  expect(queued.map((r) => [r.status, r.sweepId, r.sweepLabel, r.fit])).toEqual([
    ['queued', s.id, '-ncmoe 0', 'fits'],
    ['queued', s.id, '-ncmoe 1', 'fits'],
    ['queued', s.id, '-ncmoe 2', 'fits'],
  ]);
  expect(sweeps.get(s.id)!.counts).toMatchObject({ total: 3, queued: 3 });
  expect(runs.nextQueued(s.id)!.id).toBe(queued[0]!.id);
  runs.begin(queued[0]!.id, { command: 'cmd', hardware: hw });
  runs.finish(queued[0]!.id, {
    status: 'ok',
    pp: { tps: 900, stddev: 9, tokens: 512 },
    tg: { tps: 50, stddev: 0.5, tokens: 128 },
  });
  sweeps.setStatus(s.id, 'running', { bestRunId: queued[0]!.id });
  expect(sweeps.get(s.id)!.best).toEqual({ label: '-ncmoe 0', kind: 'bench', ppTps: 900, tgTps: 50 });
  expect(runs.list({}).map((r) => r.id)).toEqual([]); // sweep runs are hidden by default
  runs.delete(queued[0]!.id);
  expect(sweeps.get(s.id)!.bestRunId).toBeNull();
  expect(sweeps.get(s.id)!.best).toBeNull();
  expect(runs.cancelQueued(s.id)).toBe(2);
  expect(sweeps.delete(s.id)).toEqual([queued[1]!.id, queued[2]!.id]);
  expect(runs.list({ sweepId: 'all' })).toEqual([]);
});

test('stopOrphans interrupts running sweeps and their running item', () => {
  const db = openDb(':memory:');
  const runs = new BenchRunsRepo(db);
  const sweeps = new SweepsRepo(db);
  const s = sweeps.create(sweepSpec);
  const [a] = runs.enqueue(s.id, items(2));
  runs.begin(a!.id, { command: 'c', hardware: hw });
  expect(runs.stopOrphans()).toBe(1);
  expect(sweeps.stopOrphans()).toBe(1);
  expect(sweeps.get(s.id)!.status).toBe('interrupted');
  expect(runs.requeueInterrupted(s.id)).toBe(1);
  expect(sweeps.get(s.id)!.counts.queued).toBe(2);
});
