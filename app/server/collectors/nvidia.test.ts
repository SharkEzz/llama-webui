import { NodeServices } from '@effect/platform-node';
import { assert, layer } from '@effect/vitest';
import {
  Array as Arr,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Option,
  Path,
  Schedule,
  type Scope,
  String as Str,
} from 'effect';
import type { ChildProcessSpawner } from 'effect/process';
import { isAlive } from '../llama/procScan.ts';
import { MEASURE_ALL } from './gpu.ts';
import { makeNvidiaSmi, parseComputeApps, parseNvidiaGpuLine } from './nvidia.ts';

const MiB = 1024 ** 2;
const CARD = 'nvidia:GPU-c7eed07b-43d3-7fe3-0db0-0e51acaf7d28';
const LINE =
  '0, GPU-c7eed07b-43d3-7fe3-0db0-0e51acaf7d28, NVIDIA GeForce RTX 5070 Ti, 0, 5895, 16303, 38, 49.86, 00000000:01:00.0';

const fx = (name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs.readFileString(path.resolve(import.meta.dirname, '../../../testdata', name));
  });

/** One start of a fake program: its pid and its arguments. */
interface Call {
  readonly pid: number;
  readonly args: ReadonlyArray<string>;
}

/**
 * A folder of the test's own, removed with the scope. `script` writes an executable shell script that records each
 * of its starts (`<pid> <args>`) in `calls`, then runs `body`; `$DIR` is the folder.
 */
const workspace = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'lw-nv-' });
  const file = (name: string) => path.join(dir, name);
  const write = (name: string, text: string) => fs.writeFileString(file(name), text);
  const script = Effect.fn('script')(function* (name: string, body: string) {
    yield* write(name, `#!/bin/sh\nDIR='${dir}'\necho "$$ $*" >> "$DIR/calls"\n${body}\n`);
    yield* fs.chmod(file(name), 0o755);
    return file(name);
  });
  const calls = Effect.gen(function* () {
    if (!(yield* fs.exists(file('calls')))) return [];
    const text = yield* fs.readFileString(file('calls'));
    return Arr.map(Str.split(Str.trim(text), '\n'), (line): Call => {
      const [pid = '', ...args] = Str.split(line, ' ');
      return { pid: Number(pid), args };
    });
  }).pipe(Effect.orDie);
  /** Every program the test started is gone. */
  const assertAllDead = Effect.gen(function* () {
    const all = yield* calls;
    const alive = yield* Effect.filter(all, (c) => isAlive(c.pid));
    assert.deepStrictEqual(alive, []);
  });
  return { dir, file, write, script, calls, assertAllDead };
});

/** `effect` again every 20 ms until `ok` holds, 3 s at most. */
const eventually = <A, E, R>(effect: Effect.Effect<A, E, R>, ok: (a: A) => boolean) =>
  effect.pipe(Effect.repeat({ until: ok, schedule: Schedule.spaced('20 millis') }), Effect.timeout('3 seconds'));

type Services = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner;

/** `test` in a workspace; once the reader's scope is closed, every fake it started must be dead. */
const withFakes = <A, E>(
  test: (ws: Effect.Success<typeof workspace>) => Effect.Effect<A, E, Services | Scope.Scope>,
): Effect.Effect<void, E | Error, Services> =>
  Effect.scoped(
    Effect.gen(function* () {
      const ws = yield* workspace;
      yield* Effect.scoped(test(ws));
      yield* ws.assertAllDead;
    }),
  );

/** A fake nvidia-smi: the GPU stream prints `stream`, the compute-apps query runs `apps`. */
const fakeSmi = (ws: Effect.Success<typeof workspace>, stream: string, apps: string) =>
  ws.script(
    'nvidia-smi',
    `case "$*" in
  *--query-compute-apps*) ${apps} ;;
  *) ${stream} ;;
esac`,
  );

layer(NodeServices.layer, { excludeTestServices: true })('nvidia-smi', (it) => {
  it.effect('parseNvidiaGpuLine', () =>
    Effect.sync(() => {
      assert.deepStrictEqual(Option.getOrNull(parseNvidiaGpuLine(LINE)), {
        key: CARD,
        vendor: 'nvidia',
        name: 'NVIDIA GeForce RTX 5070 Ti',
        busId: '0000:01:00.0',
        utilPct: 0,
        vramUsedBytes: 5895 * MiB,
        vramTotalBytes: 16303 * MiB,
        tempC: 38,
        powerW: 49.86,
      });
      assert.isNull(Option.getOrThrow(parseNvidiaGpuLine(Str.replace('49.86', '[N/A]')(LINE))).powerW);
      assert.isTrue(Option.isNone(parseNvidiaGpuLine('garbage')));
    }),
  );

  it.effect('parseComputeApps', () =>
    Effect.gen(function* () {
      const csv = yield* fx('nvidia-apps.csv');
      const apps = parseComputeApps(csv);
      assert.strictEqual(apps.length, 2);
      assert.deepStrictEqual(apps[0], {
        pid: 49730,
        uuid: 'GPU-c7eed07b-43d3-7fe3-0db0-0e51acaf7d28',
        usedBytes: 5875 * MiB,
      });
    }),
  );

  it.effect('NvidiaMonitor streams lines split across chunks', () =>
    withFakes((ws) =>
      Effect.gen(function* () {
        const csv = yield* fx('nvidia-gpu.csv');
        yield* ws.write('a', Str.slice(0, 30)(csv));
        yield* ws.write('b', Str.slice(30, 120)(csv));
        yield* ws.write('c', Str.slice(120)(csv));
        const bin = yield* fakeSmi(
          ws,
          'cat "$DIR/a"; sleep 0.05; cat "$DIR/b"; sleep 0.05; cat "$DIR/c"; exec sleep 60',
          'exit 0',
        );
        const smi = yield* makeNvidiaSmi({ bin, intervalMs: 1000 });
        yield* smi.start;
        const gpus = yield* eventually(smi.gpus, (g) => g.length === 2);
        assert.strictEqual(gpus.length, 2);
        assert.strictEqual(gpus[1]?.name, 'NVIDIA GeForce RTX 5060 Ti');
      }),
    ),
  );

  it.effect('NvidiaMonitor procVram from compute apps', () =>
    withFakes((ws) =>
      Effect.gen(function* () {
        const apps = yield* fx('nvidia-apps.csv');
        yield* ws.write('apps', apps);
        const bin = yield* fakeSmi(ws, 'exec sleep 60', 'cat "$DIR/apps"');
        const smi = yield* makeNvidiaSmi({ bin, intervalMs: 1000 });
        yield* smi.refreshApps;
        const m = yield* smi.procVram(49730);
        assert.strictEqual(m.get(CARD), 5875 * MiB);
        const none = yield* smi.procVram(1);
        assert.strictEqual(none.size, 0);
      }),
    ),
  );

  it.effect("compute apps with [N/A] memory keep the process on its card, counting the card's VRAM in use", () =>
    withFakes((ws) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(parseComputeApps('49730, GPU-x, [N/A]\n'), [
          { pid: 49730, uuid: 'GPU-x', usedBytes: null },
        ]);
        const csv = yield* fx('nvidia-gpu.csv');
        yield* ws.write('gpus', csv);
        yield* ws.write('apps', '49730, GPU-c7eed07b-43d3-7fe3-0db0-0e51acaf7d28, [N/A]\n');
        const bin = yield* fakeSmi(ws, 'cat "$DIR/gpus"; exec sleep 60', 'cat "$DIR/apps"');
        const smi = yield* makeNvidiaSmi({ bin, intervalMs: 1000 });
        yield* smi.start;
        const gpus = yield* eventually(smi.gpus, (g) => g.length === 2);
        yield* smi.refreshApps;
        const card = Arr.findFirst(gpus, (g) => g.key === CARD).pipe(Option.getOrThrow);
        const m = yield* smi.procVram(49730);
        assert.strictEqual(m.get(card.key), card.vramUsedBytes);
      }),
    ),
  );

  it.effect('NvidiaMonitor without nvidia-smi stays empty', () =>
    withFakes((ws) =>
      Effect.gen(function* () {
        const smi = yield* makeNvidiaSmi({ bin: ws.file('no-such-nvidia-smi'), intervalMs: 1000 });
        yield* smi.start;
        yield* smi.refreshApps;
        const gpus = yield* smi.gpus;
        assert.deepStrictEqual(gpus, []);
        const available = yield* smi.available;
        assert.isFalse(available);
      }),
    ),
  );

  it.effect('a compute-apps read abandoned on timeout may fail later without reaching the process', () =>
    withFakes((ws) =>
      Effect.gen(function* () {
        const apps = yield* fx('nvidia-apps.csv');
        yield* ws.write('apps', apps);
        // The first query answers; the next ones print half a line and hang.
        const bin = yield* fakeSmi(
          ws,
          'exec sleep 60',
          '[ -f "$DIR/answered" ] && { printf "49730, GPU-"; exec sleep 60; }; touch "$DIR/answered"; cat "$DIR/apps"',
        );
        const smi = yield* makeNvidiaSmi({ bin, intervalMs: 1000, appsTimeout: '300 millis' });
        yield* smi.refreshApps;
        const unhandled: Array<unknown> = [];
        const onUnhandled = (e: unknown) => unhandled.push(e);
        yield* Effect.acquireRelease(
          Effect.sync(() => process.on('unhandledRejection', onUnhandled)),
          () => Effect.sync(() => process.off('unhandledRejection', onUnhandled)),
        );
        const exit = yield* Effect.exit(smi.refreshApps);
        assert.isTrue(Exit.isSuccess(exit));
        yield* Effect.sleep('300 millis');
        assert.deepStrictEqual(unhandled, []);
        // The mapping of the first query is kept.
        const m = yield* smi.procVram(49730);
        assert.strictEqual(m.get(CARD), 5875 * MiB);
      }),
    ),
  );

  it.effect("hung nvidia-smi compute-apps query times out, is killed, and calls don't pile up", () =>
    withFakes((ws) =>
      Effect.gen(function* () {
        const bin = yield* fakeSmi(ws, 'exec sleep 60', 'exec sleep 30');
        const smi = yield* makeNvidiaSmi({ bin, intervalMs: 1000, appsTimeout: '300 millis' });
        const [elapsed] = yield* Effect.all([smi.refreshApps, smi.refreshApps], { concurrency: 2 }).pipe(Effect.timed);
        assert.isBelow(Duration.toMillis(elapsed), 2000);
        const calls = yield* ws.calls;
        assert.strictEqual(calls.length, 1);
        yield* Effect.sleep('50 millis');
        const alive = yield* isAlive(calls[0]?.pid ?? 0);
        assert.isFalse(alive);
      }),
    ),
  );

  it.effect('configure restarts a running nvidia-smi stream at the new pace, and only then', () =>
    withFakes((ws) =>
      Effect.gen(function* () {
        const bin = yield* fakeSmi(ws, 'exec sleep 60', 'exit 0');
        const smi = yield* makeNvidiaSmi({ bin, intervalMs: 1000 });
        yield* smi.configure({ intervalMs: 500, needs: MEASURE_ALL }); // not started: nothing to restart
        yield* Effect.sleep('100 millis');
        const none = yield* ws.calls;
        assert.deepStrictEqual(none, []);
        yield* smi.start;
        yield* smi.configure({ intervalMs: 500, needs: MEASURE_ALL }); // same pace
        const first = yield* eventually(ws.calls, (c) => c.length === 1);
        yield* Effect.sleep('100 millis');
        const still = yield* ws.calls;
        assert.strictEqual(still.length, 1);
        assert.deepStrictEqual(first[0]?.args.slice(-2), ['-lms', '500']);
        yield* smi.configure({ intervalMs: 2000, needs: MEASURE_ALL });
        const both = yield* eventually(ws.calls, (c) => c.length === 2);
        const killed = yield* eventually(isAlive(first[0]?.pid ?? 0), (alive) => !alive);
        assert.isFalse(killed);
        assert.deepStrictEqual(both[1]?.args.slice(-2), ['-lms', '2000']);
      }),
    ),
  );
});
