import { Array as Arr, Effect, FileSystem, Option, Path } from 'effect';
import { parseCmdline, portFromArgv } from 'llamacpp-js/node';

/**
 * The pid of the `llama-server` listening on `port`, read from `/proc` (Linux; `root` for a test): the first process
 * whose command line names a program `llama-server` with that `--port` (8080, its default, when it names none). An
 * entry that cannot be read is skipped; a root that cannot be read gives none.
 */
export const findLlamaServerPid = Effect.fn('procScan.findLlamaServerPid')(function* (options: {
  readonly port: number;
  readonly root?: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = options.root ?? '/proc';
  const entries = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  const isServerOnPort = (entry: string) =>
    fs.readFileString(path.join(root, entry, 'cmdline')).pipe(
      Effect.map((raw) => {
        const argv = parseCmdline(raw);
        return (
          argv.length > 0 && path.basename(argv[0] ?? '') === 'llama-server' && portFromArgv(argv) === options.port
        );
      }),
      Effect.orElseSucceed(() => false),
    );
  const pids = Arr.filter(entries, (entry: string) => /^\d+$/.test(entry));
  const found = yield* Effect.findFirst(pids, isServerOnPort);
  return Option.map(found, Number);
});

/** Whether a process with this pid exists: signal 0, which only checks. */
export const isAlive = (pid: number): Effect.Effect<boolean> =>
  Effect.try({ try: () => process.kill(pid, 0), catch: () => 'gone' }).pipe(Effect.isSuccess);
