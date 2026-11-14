import { NodeServices } from '@effect/platform-node';
import { assert, layer } from '@effect/vitest';
import { Array as Arr, Effect, FileSystem, Path, Schedule, type Scope, String as Str } from 'effect';
import type { ChildProcessSpawner } from 'effect/process';
import { isAlive } from '../llama/procScan.ts';
import { makeMemBandwidth, parsePerfLine } from './membw.ts';

/** One start of a fake program: its pid and its command line (the program first). */
interface Call {
  readonly pid: number;
  readonly args: ReadonlyArray<string>;
}

/**
 * A folder of the test's own, removed with the scope. `perf` writes there an executable shell script, the fake perf,
 * that records each of its starts (`<pid> <argv>`) in `calls`, then runs `body`; `$DIR` is the folder.
 */
const workspace = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'lw-perf-' });
  const bin = path.join(dir, 'perf');
  const calls = path.join(dir, 'calls');
  const perf = Effect.fn('perf')(function* (body: string) {
    yield* fs.writeFileString(bin, `#!/bin/sh\nDIR='${dir}'\necho "$$ $0 $*" >> "$DIR/calls"\n${body}\n`);
    yield* fs.chmod(bin, 0o755);
    return bin;
  });
  const recorded = Effect.gen(function* () {
    if (!(yield* fs.exists(calls))) return [];
    const text = yield* fs.readFileString(calls);
    return Arr.map(Str.split(Str.trim(text), '\n'), (line): Call => {
      const [pid = '', ...args] = Str.split(line, ' ');
      return { pid: Number(pid), args };
    });
  }).pipe(Effect.orDie);
  const argsOf = Effect.map(
    recorded,
    Arr.map((c) => c.args),
  );
  /** Every program the test started is gone. */
  const assertAllDead = Effect.gen(function* () {
    const all = yield* recorded;
    const alive = yield* Effect.filter(all, (c) => isAlive(c.pid));
    assert.deepStrictEqual(alive, []);
  });
  return { dir, bin, perf, recorded, argsOf, assertAllDead };
});

type Workspace = Effect.Success<typeof workspace>;
type Services = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner;

/** `test` in a workspace; once the sampler's scope is closed, every fake it started must be dead. */
const withFakes = <A, E>(test: (ws: Workspace) => Effect.Effect<A, E, Services | Scope.Scope>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const ws = yield* workspace;
      yield* Effect.scoped(test(ws));
      yield* ws.assertAllDead;
    }),
  );

/** `effect` again every 10 ms until `ok` holds, 3 s at most. */
const eventually = <A, E, R>(effect: Effect.Effect<A, E, R>, ok: (a: A) => boolean) =>
  effect.pipe(Effect.repeat({ until: ok, schedule: Schedule.spaced('10 millis') }), Effect.orDie);

/** Shell that prints `lines` with a short pause between them. */
const printed = (lines: ReadonlyArray<string>) =>
  Arr.join(
    Arr.map(lines, (l) => `echo '${l}'; sleep 0.01`),
    '; ',
  );

/** The fake perf: the system stream prints `system`, the stream of pid 42 prints `pid42`; then each `after`: stay or exit. */
const fakePerf = (ws: Workspace, o: { system: string; pid42: string; other?: string; after?: 'stay' | 'exit' }) => {
  const after = o.after === 'exit' ? 'exit 0' : 'exec sleep 60';
  return ws.perf(`case "$*" in
  *" -a "*) ${o.system}; ${after} ;;
  *" -p 42 "*) ${o.pid42}; ${after} ;;
  *) ${o.other ?? 'exit 0'} ;;
esac`);
};

const SYS = [
  '1.001,1072663,,umc_cas_cmd.rd,2010102242,100,00,,',
  '1.001,336721,,umc_cas_cmd.wr,2010094852,100,00,,',
  '2.001,252177,,umc_cas_cmd.rd,2010153752,100,00,,',
  '2.001,49654,,umc_cas_cmd.wr,2010149562,100,00,,',
];
const PROC_LINE = '1.0,3028,,ls_any_fills_from_sys.dram_io_all,8122580,100,00,,';
const TEN = '1.0,10,,ls_any_fills_from_sys.dram_io_all,1,100,00,,';

layer(NodeServices.layer, { excludeTestServices: true })('perf', (it) => {
  it.effect('parsePerfLine: perf stat CSV, unsupported counts', () =>
    Effect.sync(() => {
      assert.deepStrictEqual(parsePerfLine('1.005004537,1072663,,umc_cas_cmd.rd,2010102242,100,00,,'), {
        time: 1.005004537,
        count: 1072663,
        event: 'umc_cas_cmd.rd',
      });
      assert.deepStrictEqual(parsePerfLine('2.000352061,<not supported>,,umc_cas_cmd.wr,0,100,00,,'), {
        time: 2.000352061,
        count: null,
        event: 'umc_cas_cmd.wr',
      });
      assert.isNull(parsePerfLine('# started on Fri Nov  7 07:00:00 2026'));
      assert.isNull(parsePerfLine(''));
    }),
  );

  it.effect(
    'MemBandwidthSampler: system read/write rates from per-interval CAS counts × 64 bytes',
    () =>
      withFakes((ws) =>
        Effect.gen(function* () {
          const bin = yield* fakePerf(ws, { system: printed(SYS), pid42: 'exit 0' });
          const s = yield* makeMemBandwidth({ bin, intervalMs: 1000 });
          const close = (a: number, b: number) => Math.abs(a - b) < 1;
          const bw = yield* eventually(
            s.sample,
            (b) => b !== null && close(b.readBps, 252177 * 64) && close(b.writeBps, 49654 * 64),
          );
          const args = yield* ws.argsOf;
          assert.deepStrictEqual(args[0], [
            bin,
            'stat',
            '-a',
            '-e',
            'umc_cas_cmd.rd,umc_cas_cmd.wr',
            '-I',
            '1000',
            '-x',
            ',',
            '--log-fd',
            '1',
          ]);
          assert.closeTo(bw?.readBps ?? 0, (252177 / 1) * 64, 1);
          assert.closeTo(bw?.writeBps ?? 0, (49654 / 1) * 64, 1);
          // Stale after three intervals without a line.
          yield* Effect.sleep('3100 millis');
          const stale = yield* s.sample;
          assert.isNull(stale);
        }),
      ),
    10_000,
  );

  it.effect('MemBandwidthSampler: perf missing or event unknown → unknown, retried only after a delay', () =>
    withFakes((ws) =>
      Effect.gen(function* () {
        // perf missing: the spawn fails.
        const s = yield* makeMemBandwidth({ bin: ws.bin, intervalMs: 1000, retryAfter: '300 millis' });
        const missing = yield* s.sample;
        assert.isNull(missing);
        // Installed now: not tried before the delay (no spawn loop), tried once it passed.
        yield* fakePerf(ws, { system: printed(SYS), pid42: 'exit 0' });
        yield* s.sample;
        yield* Effect.sleep('100 millis');
        const early = yield* ws.recorded;
        assert.lengthOf(early, 0);
        yield* Effect.sleep('250 millis');
        yield* s.sample;
        const later = yield* eventually(ws.recorded, (c) => c.length > 0);
        assert.lengthOf(later, 1);
        // perf starts but exits at once (event syntax error): no data, failed, no retry before the delay.
        yield* withFakes((other) =>
          Effect.gen(function* () {
            const bin = yield* fakePerf(other, { system: 'true', pid42: 'true', after: 'exit' });
            const d = yield* makeMemBandwidth({ bin, intervalMs: 1000 });
            yield* Effect.sleep('100 millis');
            const first = yield* d.sample;
            const second = yield* d.sample;
            assert.isNull(first);
            assert.isNull(second);
            const calls = yield* other.recorded;
            assert.lengthOf(calls, 1);
          }),
        );
      }),
    ),
  );

  it.effect('MemBandwidthSampler: one perf per followed PID, replaced when the PID changes, none for a dead PID', () =>
    withFakes((ws) =>
      Effect.gen(function* () {
        // PID 7: "Problems finding threads of monitor", perf exits at once.
        const bin = yield* fakePerf(ws, { system: printed(SYS), pid42: printed([PROC_LINE]) });
        const s = yield* makeMemBandwidth({ bin, intervalMs: 1000 });
        yield* s.setPid(42);
        const proc = yield* eventually(s.procSample, (p) => p !== null);
        const args = yield* ws.argsOf;
        assert.deepStrictEqual(args[1], [
          bin,
          'stat',
          '-p',
          '42',
          '-e',
          'ls_any_fills_from_sys.dram_io_all',
          '-I',
          '1000',
          '-x',
          ',',
          '--log-fd',
          '1',
        ]);
        assert.strictEqual(proc, 3028 * 64);
        yield* s.setPid(42);
        yield* Effect.sleep('100 millis');
        const same = yield* ws.recorded;
        assert.lengthOf(same, 2); // same PID: nothing relaunched
        const pid42 = same[1]?.pid ?? 0;

        yield* s.setPid(7);
        yield* eventually(ws.recorded, (c) => c.length === 3);
        yield* eventually(isAlive(pid42), (alive) => !alive);
        yield* Effect.sleep('100 millis');
        const none = yield* s.procSample;
        assert.isNull(none);
        yield* s.setPid(7);
        yield* Effect.sleep('100 millis');
        const once = yield* ws.recorded;
        assert.lengthOf(once, 3); // a PID perf could not attach to is not retried
        yield* s.setPid(null);
        const off = yield* s.procSample;
        assert.isNull(off);
      }),
    ),
  );

  it.effect('MemBandwidthSampler: a new interval restarts the streams with it', () =>
    withFakes((ws) =>
      Effect.gen(function* () {
        const bin = yield* fakePerf(ws, { system: printed(SYS), pid42: printed([TEN]) });
        const s = yield* makeMemBandwidth({ bin, intervalMs: 1000 });
        yield* s.setPid(42);
        yield* s.configure(500);
        const calls = yield* eventually(ws.recorded, (c) => c.length === 4);
        assert.lengthOf(calls, 4);
        assert.isTrue(Arr.contains(calls[2]?.args ?? [], '500'));
        assert.isTrue(Arr.contains(calls[3]?.args ?? [], '500'));
        // The streams of the first interval are stopped.
        yield* eventually(isAlive(calls[0]?.pid ?? 0), (alive) => !alive);
        yield* eventually(isAlive(calls[1]?.pid ?? 0), (alive) => !alive);
        const bw = yield* eventually(s.sample, (b) => b !== null);
        assert.isNotNull(bw);
        const proc = yield* eventually(s.procSample, (p) => p !== null);
        assert.strictEqual(proc, 10 * 64);
      }),
    ),
  );

  it.effect('MemBandwidthSampler: a PID perf cannot attach to is not retried, even when setPid runs every tick', () =>
    withFakes((ws) =>
      Effect.gen(function* () {
        const bin = yield* fakePerf(ws, { system: printed(SYS), pid42: 'exit 0' });
        const s = yield* makeMemBandwidth({ bin, intervalMs: 1000, retryAfter: '300 millis' });
        // Monitor order: setPid then procSample in the same tick, before perf's exit has been read.
        for (let tick = 0; tick < 5; tick++) {
          yield* s.setPid(7);
          const proc = yield* s.procSample;
          assert.isNull(proc);
          yield* Effect.sleep('150 millis');
        }
        const calls = yield* ws.argsOf;
        assert.lengthOf(
          Arr.filter(calls, (c) => Arr.contains(c, '-p')),
          1,
        );
      }),
    ),
  );

  it.effect('MemBandwidthSampler: system perf failing every time is retried once per delay, not every tick', () =>
    withFakes((ws) =>
      Effect.gen(function* () {
        // Exits at once, no output (no amd_umc PMU).
        const bin = yield* fakePerf(ws, { system: 'true', pid42: 'true', after: 'exit' });
        const s = yield* makeMemBandwidth({ bin, intervalMs: 1000, retryAfter: '300 millis' });
        // About 1 s of ticks every 10 ms: the first start plus one retry per 300 ms.
        for (let i = 0; i < 100; i++) {
          yield* Effect.sleep('10 millis');
          const bw = yield* s.sample;
          assert.isNull(bw);
        }
        const calls = yield* ws.recorded;
        assert.isAtLeast(calls.length, 2);
        assert.isAtMost(calls.length, 4);
      }),
    ),
  );

  it.effect('MemBandwidthSampler: perf that dies after giving values is relaunched after the delay', () =>
    withFakes((ws) =>
      Effect.gen(function* () {
        const bin = yield* fakePerf(ws, { system: printed(SYS), pid42: printed([TEN]), after: 'exit' });
        const s = yield* makeMemBandwidth({ bin, intervalMs: 1000, retryAfter: '300 millis' });
        yield* s.setPid(42);
        yield* Effect.sleep('150 millis');
        const sample = yield* s.sample;
        const proc = yield* s.procSample;
        assert.isNull(sample); // dead: no stale values
        assert.isNull(proc);
        yield* s.setPid(42);
        const early = yield* ws.recorded;
        assert.lengthOf(early, 2);
        yield* Effect.sleep('300 millis');
        yield* s.sample;
        yield* s.setPid(42);
        const later = yield* eventually(ws.recorded, (c) => c.length === 4);
        assert.lengthOf(later, 4);
      }),
    ),
  );
});
