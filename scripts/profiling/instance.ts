// The app under measure: the production build (with hidden source maps), the server under the inspector, its API,
// the profile, and the undo that leaves the instance as it was found.
import { type ChildProcess, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import { connect } from 'node:net';
import { basename, join } from 'node:path';
import { Cdp } from './cdp.ts';
import { removeDataCopy } from './datadir.ts';
import { arr, isRecord, num, parseJson, str } from './json.ts';
import { type Options, UsageError } from './options.ts';
import { EMPTY_STATE, type RunDir, type State } from './run-dir.ts';
import { INSTALL_ARGS, removeWorktree, REPO, type Target, worktreeAddArgs } from './target.ts';

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const now = (): number => performance.now();

/** A process is gone once its /proc entry is gone or a zombie. */
export function alive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
  } catch {
    return false;
  }
}

/** The start time of a process (`/proc/<pid>/stat` field 22, in clock ticks since boot); null once it is gone. */
export function startTime(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
    const start = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
    return Number.isFinite(start) ? start : null;
  } catch {
    return null;
  }
}

/** The process a state file recorded, still running: same pid and same start time, not a pid reused since. */
export const ours = (pid: number | null, start: number | null): pid is number =>
  pid !== null && start !== null && alive(pid) && startTime(pid) === start;

/** Sends `signal`, waits for the exit, SIGKILL after `graceMs`. True when the process was running. */
export async function terminate(pid: number, graceMs = 5000, signal: NodeJS.Signals = 'SIGTERM'): Promise<boolean> {
  if (!alive(pid)) return false;
  try {
    process.kill(pid, signal);
  } catch {
    return false;
  }
  const end = now() + graceMs;
  while (alive(pid) && now() < end) await sleep(20);
  if (alive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // gone in between
    }
    while (alive(pid)) await sleep(20);
  }
  return true;
}

export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** A JSON request to the app: the body decoded, null for an empty one; an error status throws with its message. */
export async function request(
  baseUrl: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<unknown> {
  const hasBody = init.body !== undefined;
  const res = await fetch(`${baseUrl}${path}`, {
    method: init.method ?? (hasBody ? 'POST' : 'GET'),
    ...(hasBody ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  const body = text === '' ? null : parseJson(text);
  if (!res.ok) {
    const what = isRecord(body) ? `${str(body._tag)}: ${str(body.message)}` : text.slice(0, 200);
    throw new ApiError(
      `${init.method ?? (hasBody ? 'POST' : 'GET')} ${path}: ${String(res.status)} ${what}`,
      res.status,
    );
  }
  return body;
}

/** Something listens on host:port. */
export function portAnswers(host: string, port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host, port });
    socket.setTimeout(1000);
    socket.once('connect', () => {
      socket.destroy();
      done(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      done(false);
    });
    socket.once('error', () => done(false));
  });
}

export async function waitHealth(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const end = now() + timeoutMs;
  while (now() < end) {
    try {
      const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return true;
    } catch {
      // not listening yet
    }
    await sleep(5);
  }
  return false;
}

export const baseUrlOf = (host: string, port: number): string =>
  `http://${host.includes(':') ? `[${host}]` : host}:${String(port)}`;

/** The commands of a checkout, an install or a build still running. */
const commands = new Set<ChildProcess>();

/** Stops the command of a checkout, an install or a build still running: a signal to the tool alone does not reach it. */
export function stopCommands(): void {
  for (const child of commands) child.kill('SIGTERM');
}

function exec(cmd: string, args: string[], cwd: string, log: string): Promise<void> {
  const fd = openSync(log, 'a');
  return new Promise<void>((done, fail) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', fd, fd] });
    commands.add(child);
    child.once('error', (error) => {
      commands.delete(child);
      fail(error);
    });
    child.once('exit', (code, signal) => {
      commands.delete(child);
      closeSync(fd);
      if (code === 0) done();
      else fail(new Error(`${cmd} ${args.join(' ')} failed (${signal ?? `exit ${String(code)}`}): see ${log}`));
    });
  });
}

function mapsUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.map'))
    .map((e) => join(e.parentPath, e.name));
}

/**
 * Checks `commit` out in a worktree at the target's root and installs it. The path is written to the run's state
 * first: the undo removes the worktree, whatever was done in it.
 */
export async function checkoutBase(run: RunDir, target: Target, commit: string): Promise<void> {
  mkdirSync(run.path, { recursive: true });
  const log = run.file('build.log');
  run.writeState({ ...run.readState(), worktree: target.root });
  await exec('git', worktreeAddArgs(target.root, commit), REPO, log);
  await exec('pnpm', INSTALL_ARGS, target.root, log);
}

/**
 * The normal production build of a target with hidden source maps, whose maps are then moved into the run: its
 * `app/.output` ends with the same files as after `pnpm build`. Without `build`, the existing build is used and page
 * functions stay minified.
 */
export async function prepareBuild(run: RunDir, build: boolean, target: Target): Promise<{ symbolicated: boolean }> {
  if (!build) {
    if (!existsSync(target.launcher))
      throw new UsageError(`--no-build: there is no build to reuse (${target.launcher}): run pnpm build`);
    return { symbolicated: false };
  }
  mkdirSync(run.path, { recursive: true });
  const log = run.file('build.log');
  await exec('pnpm', ['exec', 'vite', 'build', '--sourcemap', 'hidden'], target.app, log);
  await exec(process.execPath, ['build/server.ts'], target.app, log);
  const maps = run.file('sourcemaps');
  mkdirSync(maps, { recursive: true });
  for (const map of mapsUnder(target.output)) renameSync(map, join(maps, basename(map)));
  return { symbolicated: true };
}

export interface Instance {
  baseUrl: string;
  serverPid: number;
  inspector: Cdp;
  api: (path: string, init?: { method?: string; body?: unknown }) => Promise<unknown>;
  uptimeS: () => Promise<number>;
  historyPoints: () => Promise<number>;
  startProfile: () => Promise<{ readyMs: number; logLines: number }>;
  llamaUrl: () => Promise<string>;
  stop: () => Promise<void>;
}

async function inspectorUrl(log: string, pid: number, timeoutMs: number): Promise<string> {
  const end = now() + timeoutMs;
  while (now() < end) {
    const url = /Debugger listening on (ws:\/\/\S+)/.exec(existsSync(log) ? readFileSync(log, 'utf8') : '')?.[1];
    if (url !== undefined) return url;
    if (!alive(pid)) break;
    await sleep(20);
  }
  throw new Error(`the server did not open its inspector: see ${log}`);
}

/** The id of the profile to launch: `--profile`, else the instance's default profile. */
export async function defaultProfileId(baseUrl: string): Promise<number | null> {
  const settings = await request(baseUrl, '/api/settings');
  return isRecord(settings) && typeof settings.defaultProfileId === 'number' ? settings.defaultProfileId : null;
}

/**
 * Starts the server of a target's build. Its working directory is the repository whatever the target, so both sides
 * of a `--base` run read the same `.env`.
 */
export async function startInstance(run: RunDir, options: Options, target: Target): Promise<Instance> {
  if (await portAnswers(options.host, options.port))
    throw new UsageError(`port ${String(options.port)} is in use: stop the instance that runs there first`);
  const baseUrl = baseUrlOf(options.host, options.port);
  const log = run.file('server.log');
  const args = ['--inspect=127.0.0.1:0', target.launcher, '--host', options.host, '--port', String(options.port)];
  if (options.dataDir !== null) args.push('--data-dir', options.dataDir);
  const fd = openSync(log, 'a');
  const child = spawn(process.execPath, args, { cwd: REPO, detached: true, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  child.unref();
  const pid = child.pid;
  if (pid === undefined) throw new Error('the server did not spawn');
  run.writeState({ ...run.readState(), serverPid: pid, serverStart: startTime(pid) });
  const inspector = await Cdp.connect(await inspectorUrl(log, pid, 10_000));
  if (!(await waitHealth(baseUrl, 30_000))) throw new Error(`the server did not answer /api/health: see ${log}`);
  const api = (path: string, init?: { method?: string; body?: unknown }) => request(baseUrl, path, init);

  const serverState = async () => {
    const view = await api('/api/server/state');
    return isRecord(view) && isRecord(view.state) ? view.state : {};
  };
  return {
    baseUrl,
    serverPid: pid,
    inspector,
    api,
    uptimeS: async () => {
      const health = await api('/api/health');
      return isRecord(health) ? num(health.uptimeMs) / 1000 : 0;
    },
    historyPoints: async () => {
      const history = await api('/api/monitor/history');
      return isRecord(history) ? arr(history.times).length : 0;
    },
    startProfile: async () => {
      const current = await defaultProfileId(baseUrl);
      const profileId = options.profile ?? current;
      if (profileId === null)
        throw new UsageError('no profile to launch: pass --profile <id> or set a default profile in the app');
      const state = run.readState();
      run.writeState({
        ...state,
        restoreDefaultProfile: state.restoreDefaultProfile ?? { id: current },
        profileStarted: true,
      });
      const logs = await api('/api/logs');
      const seq = isRecord(logs) ? num(logs.seq) : 0;
      const t0 = now();
      await api('/api/server/start', { body: { profileId } });
      const end = t0 + 600_000;
      for (;;) {
        const s = await serverState();
        if (s.kind === 'ready') break;
        if (s.kind === 'crashed' || s.kind === 'idle') throw new Error(`llama-server ${str(s.kind)} while starting`);
        if (now() > end) throw new Error('llama-server was not ready after 10 minutes');
        await sleep(100);
      }
      const readyMs = now() - t0;
      const after = await api(`/api/logs?since=${String(seq)}`);
      return { readyMs, logLines: isRecord(after) ? arr(after.lines).length : 0 };
    },
    llamaUrl: async () => {
      const s = await serverState();
      if (s.kind !== 'ready') throw new Error('llama-server is not ready');
      const host = str(s.host, '127.0.0.1');
      return baseUrlOf(host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host, num(s.port, 8080));
    },
    stop: async () => {
      inspector.close();
      await terminate(pid);
      run.writeState({ ...run.readState(), serverPid: null, serverStart: null });
    },
  };
}

/** The host and port a run's server listened on, from its run.json. */
function runAddress(run: RunDir): { host: string; port: number } {
  try {
    const info = parseJson(readFileSync(run.file('run.json'), 'utf8'));
    const options = isRecord(info) && isRecord(info.options) ? info.options : {};
    return { host: str(options.host, '127.0.0.1'), port: num(options.port, 7860) };
  } catch {
    return { host: '127.0.0.1', port: 7860 };
  }
}

const isEmpty = (s: State) =>
  s.serverPid === null &&
  s.chromePid === null &&
  s.conversations.length === 0 &&
  s.restoreDefaultProfile === null &&
  !s.profileStarted &&
  s.worktree === null &&
  !s.dataCopy;

/** What an undo did, one line per thing, and what it could not do. */
export interface Undone {
  done: string[];
  failed: string[];
}

/**
 * Undoes what a run's state.json lists. Each step stands alone: one that fails is reported and the next ones still run,
 * Chromium and the server, then the worktree of a base and the copy of the data directory, last. The API is called, and a process signalled, only when the process the state recorded
 * still runs (same pid, same start time): never a pid reused since, nor an instance started after the run.
 */
export async function undo(run: RunDir): Promise<Undone> {
  const out: Undone = { done: [], failed: [] };
  if (isEmpty(run.readState())) return out;
  // Read again at each step: a scenario still finishing may have recorded something since.
  const patch = (p: Partial<State>) => run.writeState({ ...run.readState(), ...p });
  const step = async (what: string, act: () => Promise<void>) => {
    try {
      await act();
    } catch (error) {
      out.failed.push(`could not ${what}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const { host, port } = runAddress(run);
  const baseUrl = baseUrlOf(host, port);
  const first = run.readState();
  const serverUp = () => {
    const s = run.readState();
    return ours(s.serverPid, s.serverStart);
  };
  const deleteConversations = async () => {
    const ids = run.readState().conversations;
    const deleted: number[] = [];
    for (const id of ids)
      await step(`delete the conversation ${String(id)}`, async () => {
        try {
          await request(baseUrl, `/api/chat/${String(id)}`, { method: 'DELETE' });
          deleted.push(id);
        } catch (error) {
          if (!(error instanceof ApiError && error.status === 404)) throw error;
        }
      });
    if (deleted.length > 0) out.done.push(`deleted the temporary conversations ${deleted.join(', ')}`);
    const left = run.readState().conversations.filter((id) => !ids.includes(id));
    patch({ conversations: left });
  };

  if (serverUp()) {
    await deleteConversations();
    if (first.profileStarted)
      await step('stop llama-server', async () => {
        await request(baseUrl, '/api/server/stop', { method: 'POST' });
        out.done.push('stopped llama-server');
        patch({ profileStarted: false });
      });
    const restore = first.restoreDefaultProfile;
    if (restore !== null)
      await step('restore the default profile', async () => {
        if ((await defaultProfileId(baseUrl)) !== restore.id) {
          await request(baseUrl, '/api/settings', { method: 'PATCH', body: { defaultProfileId: restore.id } });
          out.done.push(`restored the default profile to ${restore.id === null ? 'none' : `#${String(restore.id)}`}`);
        }
        patch({ restoreDefaultProfile: null });
      });
  } else if (first.conversations.length > 0 || first.restoreDefaultProfile !== null) {
    out.failed.push(
      `the run's server was gone: could not delete the conversations ${first.conversations.join(', ') || '(none)'} nor restore the default profile`,
    );
    patch({ conversations: [], restoreDefaultProfile: null, profileStarted: false });
  }
  const chrome = run.readState();
  await step('close Chromium', async () => {
    if (ours(chrome.chromePid, chrome.chromeStart) && (await terminate(chrome.chromePid)))
      out.done.push(`closed Chromium (pid ${String(chrome.chromePid)})`);
    patch({ chromePid: null, chromeStart: null });
  });
  // A conversation recorded by a scenario that was still finishing.
  if (serverUp() && run.readState().conversations.length > 0) await deleteConversations();
  const server = run.readState();
  await step('stop the server', async () => {
    // The server stops llama-server itself on SIGTERM.
    if (ours(server.serverPid, server.serverStart) && (await terminate(server.serverPid, 10_000)))
      out.done.push(`stopped the server (pid ${String(server.serverPid)})`);
    patch({ serverPid: null, serverStart: null });
  });
  const { worktree } = run.readState();
  if (worktree !== null)
    await step('remove the base worktree', () => {
      removeWorktree(worktree);
      out.done.push(`removed the base worktree (${worktree})`);
      return Promise.resolve();
    });
  if (run.readState().dataCopy)
    await step('remove the copy of the data directory', () => {
      removeDataCopy(run);
      out.done.push('removed the copy of the data directory');
      return Promise.resolve();
    });
  run.writeState({ ...EMPTY_STATE });
  return out;
}
