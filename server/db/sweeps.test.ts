import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BenchSpec, BenchSpecSchema, SweepSpecSchema } from '@llama-webui/shared';
import { BenchRunsRepo } from './benchRuns';
import { MIGRATIONS } from './migrations';
import { openDb } from './open';
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

const J5_DB = '/tmp/lw-j5/llama-webui.sqlite';
test.skipIf(!existsSync(J5_DB))('the migration keeps every J5 run', () => {
  const copy = join(mkdtempSync(join(tmpdir(), 'lw-mig-')), 'db.sqlite');
  copyFileSync(J5_DB, copy);
  const before = new Database(copy, { readonly: true })
    .query<{ n: number; max: number }, []>('SELECT count(*) n, max(id) max FROM bench_runs')
    .get()!;
  const db = openDb(copy);
  const after = db.query<{ n: number; max: number }, []>('SELECT count(*) n, max(id) max FROM bench_runs').get()!;
  expect(after).toEqual(before);
  expect(db.query<{ version: number }, []>('SELECT version FROM schema_version').get()!.version).toBe(
    MIGRATIONS.length,
  );
  const repo = new BenchRunsRepo(db);
  expect(repo.list({ sweepId: 'all', limit: 1000 })).toHaveLength(before.n);
  expect(repo.create(spec, 'x', hw).id).toBe(before.max + 1);
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
  expect(runs.list({}).map((r) => r.id)).toEqual([]); // les runs de sweep sont masqués par défaut
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
