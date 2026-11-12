import { afterAll, afterEach, expect, test } from 'bun:test';
import { join, resolve } from 'node:path';
import {
  type BenchLive,
  type BenchRun,
  type BenchSpec,
  BenchSpecSchema,
  ctxFromArgs,
  DEFAULT_SETTINGS,
  type GpuSample,
  isOomError,
  type ServerState,
  type Sweep,
  type SweepLive,
  SweepSpecSchema,
  sweepCtx,
} from '@llama-webui/shared';
import { BenchRunsRepo } from '../db/benchRuns';
import { openDb } from '../db/open';
import { SweepsRepo } from '../db/sweeps';
import { HttpError } from '../http';
import { LogBuffer } from '../logs/buffer';
import { sweepRoutes } from '../routes/sweeps';
import type { BuiltCommand } from '../supervisor/args';
import { probeHealth } from '../supervisor/health';
import { tempDir } from '../testing/tempDir';
import { type ExecutorDeps, RunExecutor } from './execute';
import { BenchGate, type ServerControl } from './gate';
import { BenchRunner } from './runner';
import { WARMUP_PROMPT } from './server';

const FAKE = resolve(import.meta.dir, '../../testdata/fake/fake-llama-server');
const modelDir = tempDir('lw-bench-');
afterAll(() => modelDir[Symbol.dispose]());
const MODEL = join(modelDir.path, 'a.gguf');
await Bun.write(MODEL, '');
const cmdA = { display: 'cmdA', profileName: 'A', profileId: 1, port: 8080 } as BuiltCommand;

afterEach(() => {
  for (const k of [
    'FAKE_BENCH_OOM',
    'FAKE_BENCH_OOM_ARG',
    'FAKE_TG_BY_ARG',
    'FAKE_BENCH_STEP_MS',
    'FAKE_PP',
    'FAKE_TG',
    'FAKE_DRAFT',
    'FAKE_LOAD_MS',
  ])
    delete process.env[k];
});

/** A fake managed server (ready, profile A) that records stops and restarts. */
function setup(
  port = 8080,
  patch?: (s: ServerControl) => void,
  deps?: Partial<ExecutorDeps>,
  shared?: { gate: BenchGate; repo: BenchRunsRepo; sweeps: SweepsRepo; calls: string[] },
) {
  const calls: string[] = shared?.calls ?? [];
  let state: ServerState = {
    kind: 'ready',
    profile: 'A',
    profileId: 1,
    pid: 1,
    host: '127.0.0.1',
    port: 8080,
    since: 0,
  };
  const server: ServerControl = {
    get state() {
      return state;
    },
    lastCommand: cmdA,
    stop: async () => {
      calls.push('stop');
      state = { kind: 'idle' };
    },
    start: async (cmd) => {
      calls.push(`start:${cmd.display}`);
      state = { kind: 'starting', profile: 'A', profileId: 1, pid: 2, host: '127.0.0.1', port: 8080, since: 0 };
    },
  };
  patch?.(server);
  const lives: (BenchLive | null)[] = [];
  const runs: BenchRun[] = [];
  const sweepLives: (SweepLive | null)[] = [];
  const sweepEvents: Sweep[] = [];
  let ended!: () => void;
  const end = new Promise<void>((r) => (ended = r));
  const db = shared ? null : openDb(':memory:');
  const repo = shared?.repo ?? new BenchRunsRepo(db!);
  const sweeps = shared?.sweeps ?? new SweepsRepo(db!);
  const logs = new LogBuffer(100);
  const gate = shared?.gate ?? new BenchGate({ server, logs, adoptGraceMs: 0 });
  const executor = new RunExecutor({
    settings: () => ({ ...DEFAULT_SETTINGS, binary: FAKE, port }),
    logs,
    gpus: () => [],
    disk: () => null,
    ...deps,
  });
  const runner = new BenchRunner({
    repo,
    sweeps,
    gate,
    executor,
    hardware: async () => ({ cpu: 'cpu', gpus: [], build: null }),
    onLive: (l) => {
      lives.push(l);
      if (l === null) ended();
    },
    onRun: (r) => runs.push(r),
    onSweep: (sw) => sweepEvents.push(sw),
    onSweepLive: (l) => sweepLives.push(l),
    pauseMs: 0,
  });
  return { runner, executor, calls, lives, runs, end, repo, sweeps, gate, sweepLives, sweepEvents };
}

const spec = BenchSpecSchema.parse({ kind: 'bench', modelPath: MODEL, r: 2 });

test('restarts the server it stopped even when llama-bench fails', async () => {
  process.env.FAKE_BENCH_OOM = '1';
  const { runner, calls, lives, runs, end } = setup();
  const run = await runner.start(spec, { stopServer: true });
  expect(run.status).toBe('running');
  await end;
  const last = runs.at(-1)!;
  expect(last.id).toBe(run.id);
  expect(last.status).toBe('failed');
  expect(last.error!.startsWith('Out of memory')).toBe(true);
  expect(calls).toEqual(['stop', 'start:cmdA']);
  expect(lives.at(-1)).toBeNull();
  expect(runner.busy).toBe(false);
});

test('a successful run stores pp/tg and refuses a second run meanwhile', async () => {
  const { runner, lives, runs, end } = setup();
  const refused = await runner.start(spec, { stopServer: false }).catch((e) => e);
  expect(refused).toBeInstanceOf(HttpError);
  expect((refused as HttpError).code).toBe('server-running');

  await runner.start(spec, { stopServer: true });
  const again = await runner.start(spec, { stopServer: true }).catch((e) => e);
  expect((again as HttpError).status).toBe(409);
  await end;
  const last = runs.at(-1)!;
  expect(last.status).toBe('ok');
  expect(last.pp!.tps).toBeCloseTo(9817.38, 1);
  expect(last.tg!.tps).toBeCloseTo(410.81, 1);
  expect(lives.some((l) => l?.phase === 'prompt' && l.step !== null)).toBe(true);
});

test('a server run measures r times and reports draft acceptance', async () => {
  Object.assign(process.env, { FAKE_PP: '1000', FAKE_TG: '50', FAKE_DRAFT: '1', FAKE_LOAD_MS: '50' });
  const port = 18089;
  const { runner, calls, runs, end } = setup(port);
  await runner.start(BenchSpecSchema.parse({ kind: 'server', modelPath: MODEL, r: 2, p: 64, n: 8 }), {
    stopServer: true,
  });
  await end;
  const last = runs.at(-1)!;
  expect(last.error).toBeNull();
  expect(last.status).toBe('ok');
  expect(last.pp).toEqual({ tps: 1000, stddev: 0, tokens: expect.any(Number) });
  expect(last.tg!.tps).toBe(50);
  expect(last.tg!.stddev).toBe(0);
  expect(last.draftAcceptPct).toBe(47.5);
  expect(last.command).toContain(`--port ${port}`);
  expect(calls).toEqual(['stop', 'start:cmdA']);
  expect(await probeHealth(port)).toBeNull();
}, 20_000);

test('a missing model is refused before anything stops', async () => {
  const { runner, calls } = setup();
  const e = await runner
    .start(BenchSpecSchema.parse({ kind: 'bench', modelPath: '/nulle/part.gguf' }), { stopServer: true })
    .catch((x) => x);
  expect((e as HttpError).status).toBe(400);
  expect(calls).toEqual([]);
  expect(runner.busy).toBe(false);
});

test('a failed restart is recorded on the run', async () => {
  const { runner, runs, end } = setup(8080, (s) => {
    s.start = async () => {
      throw new Error('port in use');
    };
  });
  await runner.start(spec, { stopServer: true });
  await end;
  const last = runs.at(-1)!;
  expect(last.status).toBe('ok');
  expect(last.error).toContain('could not restart llama-server: port in use');
});

test('a reload while the server is stopping restarts it once the stop is over', async () => {
  // Like the supervisor: start is refused while another operation (the stop) is in progress.
  let stopping = false;
  let release!: () => void;
  const { runner, calls, repo } = setup(8080, (s) => {
    s.stop = async () => {
      stopping = true;
      calls.push('stop');
      await new Promise<void>((r) => (release = r));
      stopping = false;
    };
    s.start = async (cmd) => {
      if (stopping) throw new Error('operation in progress, try again');
      calls.push(`start:${cmd.display}`);
    };
  });
  const run = await runner.start(spec, { stopServer: true });
  runner.dispose({ restart: true });
  release();
  await Bun.sleep(50);
  expect(calls).toEqual(['stop', 'start:cmdA']);
  expect(repo.get(run.id)!.status).toBe('interrupted');
});

test("a bench run gets its profile's environment", async () => {
  const { runner, runs, end } = setup(8080, undefined, { profile: () => ({ env: { FAKE_BENCH_OOM: '1' } }) });
  await runner.start(BenchSpecSchema.parse({ kind: 'bench', modelPath: MODEL, profileId: 1, r: 1 }), {
    stopServer: true,
  });
  await end;
  expect(runs.at(-1)!.status).toBe('failed');
});

test('a server that dies of OOM is reported as OOM even when a long backtrace follows the allocation error', async () => {
  // llama.cpp prints a gdb backtrace on GGML_ASSERT: more lines than the trial keeps after the cudaMalloc failure.
  const backtrace = Array.from(
    { length: 80 },
    (_, i) => `#${i}  0x00007f739bb3219b in frame_${i} () from libggml-base.so.0`,
  );
  const lines = [
    'ggml_backend_cuda_buffer_type_alloc_buffer: allocating 8192.00 MiB on device 0: cudaMalloc failed: out of memory',
    'ggml-backend-meta.cpp:1857: GGML_ASSERT(meta_buf_ctx->bufs[i]) failed',
    ...backtrace,
  ];
  const { runner, runs, end } = setup(18091, undefined, {
    profile: () => ({ env: { FAKE_EXIT_LINES: lines.join('|') } }),
  });
  await runner.start(BenchSpecSchema.parse({ kind: 'server', modelPath: MODEL, profileId: 1, r: 1, p: 16, n: 4 }), {
    stopServer: true,
  });
  await end;
  const run = runs.at(-1)!;
  expect(run.status).toBe('failed');
  expect(isOomError(run.error)).toBe(true);
  expect(run.error).toContain('cudaMalloc failed: out of memory');
}, 20_000);

test('the warm-up prompt is a sentence: a 2-token prompt crashes llama-server with -sm tensor and an MTP draft', () => {
  // llama.cpp segfaults on a 2-token prompt with -sm tensor and --spec-type draft-mtp ("Hello." did, every time).
  expect(WARMUP_PROMPT.split(/\s+/).length).toBeGreaterThanOrEqual(6);
});

test("a server run runs in its profile's directory", async () => {
  Object.assign(process.env, { FAKE_LOAD_MS: '50' });
  using dir = tempDir('lw-cwd-');
  const cwd = dir.path;
  const { runner, runs, end } = setup(18090, undefined, { profile: () => ({ cwd, env: {} }) });
  await runner.start(BenchSpecSchema.parse({ kind: 'server', modelPath: MODEL, profileId: 1, r: 1, p: 16, n: 4 }), {
    stopServer: true,
  });
  await end;
  expect(runs.at(-1)!.logExcerpt).toContain(`cwd ${cwd}`);
}, 20_000);

/** A llama-bench sweep: one item per -ncmoe value. */
function sweepOf(repo: BenchRunsRepo, sweeps: SweepsRepo, values: number[]) {
  const sw = sweeps.create(
    SweepSpecSchema.parse({ name: 's', modelPath: MODEL, preset: 'chat', r: 1, space: { ncmoe: values } }),
  );
  const items = values.map((v) => ({
    spec: { ...spec, r: 1, params: { ncmoe: v } } as BenchSpec,
    label: `-ncmoe ${v}`,
    fit: 'fits' as const,
  }));
  return { sweep: sw, runs: repo.enqueue(sw.id, items) };
}
const sweepEnd = (lives: (SweepLive | null)[]) =>
  new Promise<void>((resolve) => {
    const t = setInterval(() => {
      if (lives.length > 0 && lives.at(-1) === null) {
        clearInterval(t);
        resolve();
      }
    }, 10);
  });

test('a sweep stops the server once, continues after an OOM item and restarts it once', async () => {
  Object.assign(process.env, {
    FAKE_BENCH_OOM_ARG: '-ncmoe 4',
    FAKE_TG_BY_ARG: '-ncmoe 8=30;-ncmoe 16=20',
    FAKE_BENCH_STEP_MS: '5',
  });
  const { runner, calls, repo, sweeps, sweepLives } = setup();
  const { sweep } = sweepOf(repo, sweeps, [4, 8, 16]);
  await runner.startSweep(sweep.id, { stopServer: true });
  await sweepEnd(sweepLives);
  expect(calls).toEqual(['stop', 'start:cmdA']);
  const done = repo.list({ sweepId: sweep.id });
  expect(done.map((r) => r.status)).toEqual(['failed', 'ok', 'ok']);
  expect(done[0]!.error!.startsWith('Out of memory')).toBe(true);
  const final = sweeps.get(sweep.id)!;
  expect(final.status).toBe('done');
  expect(final.bestRunId).toBe(done[1]!.id);
  expect(done[1]!.tg!.tps).toBe(30);
  expect(runner.busy).toBe(false);
});

test('cancelSweep cancels the queue and releases the gate', async () => {
  process.env.FAKE_BENCH_STEP_MS = '200';
  const { runner, calls, repo, sweeps, sweepLives, gate } = setup();
  const { sweep } = sweepOf(repo, sweeps, [1, 2, 3]);
  await runner.startSweep(sweep.id, { stopServer: true });
  await Bun.sleep(100);
  expect(runner.cancelSweep(sweep.id)).toBe(true);
  await sweepEnd(sweepLives);
  expect(repo.list({ sweepId: sweep.id }).map((r) => r.status)).toEqual(['cancelled', 'cancelled', 'cancelled']);
  expect(sweeps.get(sweep.id)!.status).toBe('cancelled');
  expect(calls).toEqual(['stop', 'start:cmdA']);
  expect(gate.held).toBe(false);
});

test('after a reload the interrupted item is replayed only once the killed process has exited', async () => {
  Object.assign(process.env, { FAKE_BENCH_STEP_MS: '60' });
  const first = setup();
  const { sweep } = sweepOf(first.repo, first.sweeps, [1, 2]);
  await first.runner.startSweep(sweep.id, { stopServer: true });
  while (!first.runs.some((r) => r.status === 'running')) await Bun.sleep(10);
  await Bun.sleep(80);
  // A killed process that is slow to exit (the driver frees its VRAM): replaying before that means two llama-bench on the same cards.
  const kill = first.executor.killNow.bind(first.executor);
  let exitedAt = 0;
  first.executor.killNow = async () => {
    await kill();
    await Bun.sleep(300);
    exitedAt = Date.now();
  };
  first.runner.dispose({ restart: true });
  const second = setup(8080, undefined, undefined, {
    gate: first.gate,
    repo: first.repo,
    sweeps: first.sweeps,
    calls: first.calls,
  });
  await second.runner.resume();
  while (!second.runs.some((r) => r.status === 'running')) await Bun.sleep(5);
  expect(exitedAt).toBeGreaterThan(0);
  await sweepEnd(second.sweepLives);
  expect(first.repo.list({ sweepId: sweep.id }).map((r) => r.status)).toEqual(['ok', 'ok']);
  expect(first.calls).toEqual(['stop', 'start:cmdA']);
}, 20_000);

test('a reload hands the held gate to the next runner, which replays the interrupted item', async () => {
  Object.assign(process.env, { FAKE_BENCH_STEP_MS: '60' });
  const first = setup();
  const { sweep } = sweepOf(first.repo, first.sweeps, [1, 2, 3]);
  await first.runner.startSweep(sweep.id, { stopServer: true });
  // During item 2.
  while (first.repo.list({ sweepId: sweep.id }).filter((r) => r.status === 'ok').length < 1) await Bun.sleep(10);
  await Bun.sleep(80);
  first.runner.dispose({ restart: true });
  const second = setup(8080, undefined, undefined, {
    gate: first.gate,
    repo: first.repo,
    sweeps: first.sweeps,
    calls: first.calls,
  });
  await second.runner.resume();
  await sweepEnd(second.sweepLives);
  expect(first.calls).toEqual(['stop', 'start:cmdA']);
  expect(first.repo.list({ sweepId: sweep.id }).map((r) => r.status)).toEqual(['ok', 'ok', 'ok']);
  expect(first.sweeps.get(sweep.id)!.status).toBe('done');
  expect(first.gate.held).toBe(false);
}, 20_000);

test('a reload that finds the gate already being released marks the orphan sweep interrupted instead of leaving it running', async () => {
  // The reload took longer than the grace period: the old gate restarts the server (slowly) when the new module starts.
  const { runner, gate, repo, sweeps, sweepEvents } = setup(8080, (s) => {
    s.start = () => new Promise(() => {});
  });
  await gate.acquire({ stopServer: true });
  void gate.release();
  const { sweep } = sweepOf(repo, sweeps, [1, 2]);
  expect(gate.held).toBe(true); // so index.ts does not run stopOrphans()
  await runner.resume();
  expect(sweeps.get(sweep.id)!.status).toBe('interrupted');
  expect(sweepEvents.at(-1)?.status).toBe('interrupted');
});

test('validating an interrupted sweep also finishes its interrupted items', async () => {
  const { runner, repo, sweeps, sweepLives } = setup();
  const { sweep } = sweepOf(repo, sweeps, [1, 2]);
  await runner.startSweep(sweep.id, { stopServer: true });
  await sweepEnd(sweepLives);
  // As after a Ctrl-C in the middle of item 2.
  const second = repo.list({ sweepId: sweep.id }).find((r) => r.sweepLabel === '-ncmoe 2')!;
  repo.finish(second.id, { status: 'interrupted', error: 'interrupted' });
  sweeps.setStatus(sweep.id, 'interrupted');
  const routes = sweepRoutes({
    sweeps,
    benchRuns: repo,
    benchRunner: runner,
    settings: null!,
    monitor: null!,
    hub: { broadcast() {} } as never,
  });
  const req = Object.assign(
    new Request(`http://127.0.0.1:7860/api/sweeps/${sweep.id}/validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ n: 1, stopServer: true }),
    }),
    {
      params: { id: String(sweep.id) },
    },
  );
  expect((await routes['/api/sweeps/:id/validate'].POST(req as never, null as never))!.status).toBe(202);
  while (sweeps.get(sweep.id)!.status === 'running') await Bun.sleep(10);
  expect(repo.list({ sweepId: sweep.id }).filter((r) => r.status === 'interrupted')).toEqual([]);
  expect(sweeps.get(sweep.id)!.status).toBe('done');
}, 20_000);

test('the VRAM sampler takes its last reading when the run ends, then stops', async () => {
  // A card holding 1 GiB when the run starts, 3 GiB afterwards.
  let calls = 0;
  const gpus = () => [
    {
      key: 'g0',
      name: 'Fake GPU',
      vendor: 'other',
      vramUsedBytes: (calls++ === 0 ? 1 : 3) * 1024 ** 3,
    } as unknown as GpuSample,
  ];
  for (const [port, s] of [
    [8080, spec],
    [18091, BenchSpecSchema.parse({ kind: 'server', modelPath: MODEL, r: 1, p: 16, n: 4 })],
  ] as const) {
    Object.assign(process.env, { FAKE_LOAD_MS: '50' });
    calls = 0;
    const { runner, runs, end } = setup(port, undefined, { gpus });
    await runner.start(s, { stopServer: true });
    await end;
    expect(runs.at(-1)!.status).toBe('ok');
    expect(runs.at(-1)!.vramPeak).toEqual([{ key: 'g0', name: 'Fake GPU', mib: 2048 }]);
    // Released with the run: no reading afterwards (a leaked sampler would keep polling every SAMPLE_MS).
    const after = calls;
    await Bun.sleep(1200);
    expect(calls).toBe(after);
  }
}, 20_000);

test('server validation runs get the sweep context when the profile sets no -c (#24)', async () => {
  const { runner, repo, sweeps, sweepLives } = setup();
  const { sweep } = sweepOf(repo, sweeps, [1, 2]);
  await runner.startSweep(sweep.id, { stopServer: true });
  await sweepEnd(sweepLives);
  const routes = sweepRoutes({
    sweeps,
    benchRuns: repo,
    benchRunner: runner,
    settings: null!,
    monitor: null!,
    hub: { broadcast() {} } as never,
  });
  const req = Object.assign(
    new Request(`http://127.0.0.1:7860/api/sweeps/${sweep.id}/validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ n: 1, stopServer: true }),
    }),
    { params: { id: String(sweep.id) } },
  );
  expect((await routes['/api/sweeps/:id/validate'].POST(req as never, null as never))!.status).toBe(202);
  while (sweeps.get(sweep.id)!.status === 'running') await Bun.sleep(10);
  const validation = repo.list({ sweepId: sweep.id }).find((r) => r.kind === 'server')!;
  expect(ctxFromArgs(sweep.spec.serverArgs)).toBeUndefined();
  expect(ctxFromArgs(validation.spec.serverArgs)).toBe(sweepCtx(sweep.spec));
}, 20_000);

test('resuming a sweep whose model was deleted is one 400, before anything stops (#37)', async () => {
  const { runner, calls, repo, sweeps } = setup();
  const sw = sweeps.create(
    SweepSpecSchema.parse({ name: 's', modelPath: '/nulle/part.gguf', preset: 'chat', r: 1, space: { ncmoe: [1] } }),
  );
  repo.enqueue(sw.id, [
    { spec: { ...spec, modelPath: '/nulle/part.gguf', r: 1 } as BenchSpec, label: 'x', fit: 'fits' },
  ]);
  sweeps.setStatus(sw.id, 'interrupted');
  const routes = sweepRoutes({
    sweeps,
    benchRuns: repo,
    benchRunner: runner,
    settings: null!,
    monitor: null!,
    hub: { broadcast() {} } as never,
  });
  const req = Object.assign(
    new Request(`http://127.0.0.1:7860/api/sweeps/${sw.id}/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stopServer: true }),
    }),
    { params: { id: String(sw.id) } },
  );
  const res = (await routes['/api/sweeps/:id/resume'].POST(req as never, null as never))!;
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toBe('Model not found: /nulle/part.gguf');
  expect(calls).toEqual([]);
  expect(sweeps.get(sw.id)!.status).toBe('interrupted');
});
