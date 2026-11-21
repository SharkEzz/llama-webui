// Child processes and file reads on node:*, with web streams and an `exited` promise, so call sites read them
// alike: `new Response(proc.stdout).text()`, `for await (const chunk of proc.stdout)`.
import { type ChildProcess, spawn } from 'node:child_process';
import { accessSync, constants, createReadStream, existsSync, statSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { Readable } from 'node:stream';

type Stdio = 'pipe' | 'ignore';
/** The stream of an output: null when it is ignored. */
type Output<S extends Stdio> = S extends 'ignore' ? null : ReadableStream<Uint8Array>;

/** A started process. `Spawned` alone has outputs that may be null; `spawnProc` types them from its options. */
export interface Spawned<O extends Stdio = Stdio, E extends Stdio = Stdio> {
  pid: number;
  stdout: Output<O>;
  stderr: Output<E>;
  /** Resolves once the process has exited (`exitCode`/`signalCode` are set), with its exit code. */
  exited: Promise<number | null>;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): void;
}

/** Standard input is never given to the child (`ignore`). */
export interface SpawnOptions<O extends Stdio = Stdio, E extends Stdio = Stdio> {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** `pipe` by default. */
  stdout?: O;
  stderr?: E;
  /** Killed with `killSignal` (default SIGTERM) after this many milliseconds. */
  timeout?: number;
  killSignal?: NodeJS.Signals;
}

export type Spawn = <O extends Stdio = 'pipe', E extends Stdio = 'pipe'>(
  argv: string[],
  o?: SpawnOptions<O, E>,
) => Spawned<O, E>;

const toWeb = <S extends Stdio>(s: ChildProcess['stdout']) => (s ? Readable.toWeb(s) : null) as Output<S>;

/**
 * Why a spawn failed, as Node would report it: the `'error'` event only comes after `spawn()` has returned. A bare
 * name is looked up in the child's PATH, as Node does.
 */
function spawnErrorCode(bin: string, cwd: string | undefined, path: string): string {
  if (cwd !== undefined && !existsSync(cwd)) return 'ENOENT';
  const file = bin.includes('/') ? bin : which(bin, path);
  if (file === null || !existsSync(file)) return 'ENOENT';
  if (statSync(file).isDirectory()) return 'EACCES';
  try {
    accessSync(file, constants.X_OK);
  } catch {
    return 'EACCES';
  }
  return 'UNKNOWN';
}

/**
 * Starts `argv`. Throws at once when the process cannot start (missing binary or `cwd`, not executable):
 * callers handle a failed launch in a `try`/`catch` around this call.
 */
export const spawnProc: Spawn = <O extends Stdio, E extends Stdio>(argv: string[], o: SpawnOptions<O, E> = {}) => {
  const [bin, ...args] = argv;
  if (bin === undefined) throw new Error('spawn: empty command');
  const child = spawn(bin, args, {
    cwd: o.cwd,
    env: o.env,
    stdio: ['ignore', o.stdout ?? 'pipe', o.stderr ?? 'pipe'],
    timeout: o.timeout,
    killSignal: o.killSignal,
  });
  if (child.pid === undefined) {
    child.once('error', () => {});
    throw new Error(`spawn ${bin} ${spawnErrorCode(bin, o.cwd, (o.env ?? process.env).PATH ?? '')}`);
  }
  // Node reports a failed kill() (other than ESRCH) as an 'error' event, which crashes the server without a listener.
  // Callers already ignore kill failures.
  child.on('error', () => {});
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  const proc: Spawned<O, E> & { child: ChildProcess } = {
    child, // the tests emit on it
    pid: child.pid,
    stdout: toWeb<O>(child.stdout),
    stderr: toWeb<E>(child.stderr),
    exited,
    get exitCode() {
      return child.exitCode;
    },
    get signalCode() {
      return child.signalCode;
    },
    kill(signal = 'SIGTERM') {
      child.kill(signal);
    },
  };
  return proc;
};

/** The whole file as UTF-8; rejects when it cannot be read (call sites add their own `.catch`). */
export const readText = (path: string): Promise<string> => readFile(path, 'utf8');

/** True for a regular file only (false for a directory or a missing path). */
export const fileExists = (path: string): Promise<boolean> =>
  stat(path).then(
    (s) => s.isFile(),
    () => false,
  );

/** Bytes `[start, end)` of a file as a web stream. */
export function fileRange(path: string, start: number, end: number): ReadableStream<Uint8Array> {
  if (end <= start) return new ReadableStream({ start: (c) => c.close() });
  // 1 MiB reads: the default 64 KiB halves what the disk speed check measures from the page cache.
  return Readable.toWeb(createReadStream(path, { start, end: end - 1, highWaterMark: 1 << 20 })) as ReadableStream<
    Uint8Array<ArrayBuffer>
  >;
}

const isExecutable = (p: string): boolean => {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * Absolute path of an executable found in `path` (a PATH-style list), null if none. A name with a
 * slash is not looked up: it is returned if it is an executable file, else null.
 */
export function which(bin: string, path = process.env.PATH ?? ''): string | null {
  if (bin.includes('/')) return isExecutable(bin) ? bin : null;
  for (const dir of path.split(delimiter)) if (dir && isExecutable(join(dir, bin))) return join(dir, bin);
  return null;
}
