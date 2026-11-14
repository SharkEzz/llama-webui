import { NodeServices } from '@effect/platform-node';
import { assert, layer } from '@effect/vitest';
import { Array as Arr, Duration, Effect, Exit, Logger, Ref, Result, Scope, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { isAlive } from '../llama/procScan.ts';
import { linesOf } from '../logs/lines.ts';
import { stuckRelease } from '../testing/stuckRelease.ts';
import { CLOSE_BOUND, followProgram } from './followed.ts';

const sh = (script: string) => ChildProcess.make('/bin/sh', ['-c', script], { stdin: 'ignore', stderr: 'ignore' });

/** `effect` with the warnings it logs recorded in `warnings`, and nothing else logged. */
const withWarnings = <A, E, R>(effect: (warnings: ReadonlyArray<string>) => Effect.Effect<A, E, R>) => {
  const warnings: Array<string> = [];
  const logger = Logger.make(({ logLevel, message }) => {
    if (logLevel === 'Warn') warnings.push(String(message));
  });
  return effect(warnings).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([logger])));
};

layer(NodeServices.layer, { excludeTestServices: true })('followProgram', (it) => {
  it.effect('the output is read to its end before onExit, then the scope is closed', () =>
    Effect.gen(function* () {
      const parent = yield* Scope.make();
      const lines = yield* Ref.make<ReadonlyArray<string>>([]);
      const seen = yield* Ref.make<ReadonlyArray<string>>([]);
      const code = yield* Ref.make<number | null>(null);
      const program = yield* followProgram({
        // The last line comes after the shell's exit, from its child: only the join of the reader keeps it.
        command: ChildProcess.make('/bin/sh', ['-c', 'echo first; (sleep 0.2; echo last) & exit 0'], {
          stdin: 'ignore',
          stderr: 'ignore',
        }),
        parent,
        name: 'the test program',
        read: (p) =>
          linesOf(p.handle.stdout).pipe(
            Stream.runForEach((line) => Ref.update(lines, Arr.append(line))),
            Effect.ignore,
          ),
        onExit: (ended) =>
          Effect.gen(function* () {
            const read = yield* Ref.get(lines);
            yield* Ref.set(seen, read);
            yield* Ref.set(code, Result.isSuccess(ended) ? ended.success : null);
          }),
      });
      yield* program.ended.pipe(Effect.timeout('3 seconds'));
      const seenAtExit = yield* Ref.get(seen);
      const exitCode = yield* Ref.get(code);
      assert.deepStrictEqual(seenAtExit, ['first', 'last']);
      assert.strictEqual(exitCode, 0);
      const alive = yield* isAlive(program.handle.pid);
      assert.isFalse(alive);
      yield* Scope.close(parent, Exit.void);
    }),
  );

  it.effect('a program that cannot be spawned fails, and nothing of it is followed', () =>
    Effect.gen(function* () {
      const parent = yield* Scope.make();
      const calls = yield* Ref.make(0);
      const error = yield* Effect.flip(
        followProgram({
          command: ChildProcess.make('/nonexistent/llama-webui-test', [], { stdin: 'ignore' }),
          parent,
          name: 'the test program',
          onSpawn: () => Ref.update(calls, (n) => n + 1),
          read: () => Ref.update(calls, (n) => n + 1),
          onExit: () => Ref.update(calls, (n) => n + 1),
        }),
      );
      assert.strictEqual(error._tag, 'PlatformError');
      const called = yield* Ref.get(calls);
      assert.strictEqual(called, 0);
      yield* Scope.close(parent, Exit.void);
    }),
  );

  it.effect('a killed program whose exit never comes back: the stop returns within the bound, and says so', () =>
    withWarnings((warnings) =>
      Effect.gen(function* () {
        const stuck = yield* stuckRelease;
        const parent = yield* Scope.make();
        const exits = yield* Ref.make(0);
        const program = yield* followProgram({
          command: sh('exec sleep 60'),
          parent,
          name: 'the test program',
          read: () => Effect.void,
          onExit: () => Ref.update(exits, (n) => n + 1),
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, stuck.spawner));
        const [elapsed] = yield* Effect.timed(program.stop);
        assert.isAtLeast(Duration.toMillis(elapsed), Duration.toMillis(CLOSE_BOUND) - 50);
        assert.isBelow(Duration.toMillis(elapsed), Duration.toMillis(CLOSE_BOUND) + 500);
        assert.deepStrictEqual(warnings, ['the test program did not end 1s after its stop: left to end alone']);
        // Killed all the same, and its exit handled.
        const alive = yield* isAlive(program.handle.pid);
        assert.isFalse(alive);
        yield* program.ended.pipe(Effect.timeout('2 seconds'));
        const exited = yield* Ref.get(exits);
        assert.strictEqual(exited, 1);
        yield* stuck.unstick;
        yield* Scope.close(parent, Exit.void);
      }),
    ),
  );

  it.effect('the end of the parent closes a program whose exit never comes back within the bound', () =>
    Effect.gen(function* () {
      const stuck = yield* stuckRelease;
      const parent = yield* Scope.make();
      const program = yield* followProgram({
        command: sh('exec sleep 60'),
        parent,
        name: 'the test program',
        read: () => Effect.void,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, stuck.spawner));
      const [elapsed] = yield* Effect.timed(Scope.close(parent, Exit.void));
      assert.isBelow(Duration.toMillis(elapsed), Duration.toMillis(CLOSE_BOUND) + 500);
      const alive = yield* isAlive(program.handle.pid);
      assert.isFalse(alive);
      yield* stuck.unstick;
    }),
  );
});
