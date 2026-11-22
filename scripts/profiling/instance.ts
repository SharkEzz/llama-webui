// The app under measure: the production build (with hidden source maps), the server under the inspector, its API,
// the profile, and the undo that leaves the instance as it was found.
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import { connect } from 'node:net';
import { basename, join, resolve } from 'node:path';
import { Cdp } from './cdp.ts';
import { arr, isRecord, num, parseJson, str } from './json.ts';
import { type Options, UsageError } from './options.ts';
import { EMPTY_STATE, type RunDir, type State } from './run-dir.ts';

export const REPO = resolve(import.meta.dirname, '../..');
const APP = join(REPO, 'app');
const OUTPUT = join(APP, '.output');
export const LAUNCHER = join(OUTPUT, 'llama-webui.mjs');
export const SERVER_BUNDLE = join(OUTPUT, 'server/index.mjs');

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

function exec(cmd: string, args: string[], cwd: string, log: string): Promise<void> {
  const fd = openSync(log, 'a');
  return new Promise<void>((done, fail) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', fd, fd] });
    child.once('error', fail);
    child.once('exit', (code, signal) => {
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
 * The normal production build with hidden source maps, whose maps are then moved into the run: `app/.output` ends with
 * the same files as after `pnpm build`. Without `build`, the existing build is used and page functions stay minified.
 */
export async function prepareBuild(run: RunDir, build: boolean): Promise<{ symbolicated: boolean }> {
  if (!build) {
    if (!existsSync(LAUNCHER))
      throw new UsageError(`--no-build: there is no build to reuse (${LAUNCHER}): run pnpm build`);
    return { symbolicated: false };
  }
  mkdirSync(run.path, { recursive: true });
  const log = run.file('build.log');
  await exec('pnpm', ['exec', 'vite', 'build', '--sourcemap', 'hidden'], APP, log);
  await exec(process.execPath, ['build/server.ts'], APP, log);
  const target = run.file('sourcemaps');
  mkdirSync(target, { recursive: true });
  for (const map of mapsUnder(OUTPUT)) renameSync(map, join(target, basename(map)));
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

export async function startInstance(run: RunDir, options: Options): Promise<Instance> {
  if (await portAnswers(options.host, options.port))
    throw new UsageError(`port ${String(options.port)} is in use: stop the instance that runs there first`);
  const baseUrl = baseUrlOf(options.host, options.port);
  const log = run.file('server.log');
  const args = ['--inspect=127.0.0.1:0', LAUNCHER, '--host', options.host, '--port', String(options.port)];
  if (options.dataDir !== null) args.push('--data-dir', options.dataDir);
  const fd = openSync(log, 'a');
  const child = spawn(process.execPath, args, { cwd: REPO, detached: true, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  child.unref();
  const pid = child.pid;
  if (pid === undefined) throw new Error('the server did not spawn');
  run.writeState({ ...run.readState(), serverPid: pid });
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
      run.writeState({ ...run.readState(), serverPid: null });
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
  !s.profileStarted;

/** Undoes what a run's state.json lists, each step tolerant of what is already gone; one line per thing undone. */
export async function undo(run: RunDir): Promise<string[]> {
  let state = run.readState();
  if (isEmpty(state)) return [];
  const done: string[] = [];
  const save = (patch: Partial<State>) => {
    state = { ...state, ...patch };
    run.writeState(state);
  };
  const { host, port } = runAddress(run);
  const baseUrl = baseUrlOf(host, port);
  const serverUp = state.serverPid !== null && alive(state.serverPid);
  if (serverUp) {
    const deleted = [];
    for (const id of state.conversations) {
      try {
        await request(baseUrl, `/api/chat/${String(id)}`, { method: 'DELETE' });
        deleted.push(id);
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 404)) throw error;
      }
    }
    if (deleted.length > 0) done.push(`deleted the temporary conversations ${deleted.join(', ')}`);
    save({ conversations: [] });
    if (state.profileStarted) {
      await request(baseUrl, '/api/server/stop', { method: 'POST' });
      done.push('stopped llama-server');
      save({ profileStarted: false });
    }
    if (state.restoreDefaultProfile !== null) {
      const want = state.restoreDefaultProfile.id;
      if ((await defaultProfileId(baseUrl)) !== want) {
        await request(baseUrl, '/api/settings', { method: 'PATCH', body: { defaultProfileId: want } });
        done.push(`restored the default profile to ${want === null ? 'none' : `#${String(want)}`}`);
      }
      save({ restoreDefaultProfile: null });
    }
  } else if (state.conversations.length > 0 || state.restoreDefaultProfile !== null) {
    done.push(
      `the server was gone: could not delete the conversations ${state.conversations.join(', ') || '(none)'} nor restore the default profile`,
    );
    save({ conversations: [], restoreDefaultProfile: null, profileStarted: false });
  }
  if (state.chromePid !== null) {
    if (await terminate(state.chromePid)) done.push(`closed Chromium (pid ${String(state.chromePid)})`);
    save({ chromePid: null });
  }
  if (state.serverPid !== null) {
    // The server stops llama-server itself on SIGTERM.
    if (await terminate(state.serverPid, 10_000)) done.push(`stopped the server (pid ${String(state.serverPid)})`);
    save({ serverPid: null });
  }
  run.writeState({ ...EMPTY_STATE });
  return done;
}
