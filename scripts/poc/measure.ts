/**
 * Numbers of the server for the Effect POC: taken at E0 on the Nitro server (the baseline), taken again unchanged at
 * E10. It only relies on what both servers share: the launcher `app/.output/llama-webui.mjs`, `GET /api/health` and
 * `/ws`; files are classified by pattern, not by the folder names of either server.
 * - `node scripts/poc/measure.ts --out <file.json>`: times `pnpm build`, `pnpm check` and `pnpm test`, then measures;
 * - `--skip-durations`: measures the existing build only (`app/.output` must exist).
 */
import { type ChildProcessByStdio, execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';

const ROOT = resolve(import.meta.dirname, '../..');
const OUTPUT = join(ROOT, 'app/.output');
const LAUNCHER = join(OUTPUT, 'llama-webui.mjs');
/** Startup and shutdown are each measured this many times; the median is kept, the runs are stored. */
const RUNS = 7;
const STARTUP_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 30_000;
/** The web's client layer: the API and WebSocket clients. */
const WEB_CLIENT_LAYER = ['app/src/lib/api.ts', 'app/src/lib/ws.ts'];

export type Group = 'server' | 'serverTests' | 'shared' | 'sharedTests' | 'web' | 'webTests' | 'build';

const GROUPS: Group[] = ['server', 'serverTests', 'shared', 'sharedTests', 'web', 'webTests', 'build'];

/** The group a repo-relative path is counted in, or null when it is not counted. */
export function classify(path: string): Group | null {
  const segments = path.split('/');
  if (path.startsWith('repos/') || path.startsWith('app/server-legacy/')) return null;
  if (segments.includes('node_modules') || segments.includes('.output')) return null;
  if (!/\.tsx?$/.test(path)) return null;
  if (path === 'app/server/api.gen.ts') return null;
  if (path.startsWith('app/server/')) {
    const dirs = segments.slice(0, -1);
    const isTest = path.endsWith('.test.ts') || dirs.includes('testing') || dirs.includes('contract');
    return isTest ? 'serverTests' : 'server';
  }
  if (path.startsWith('packages/webui-shared/src/')) return path.endsWith('.test.ts') ? 'sharedTests' : 'shared';
  if (path.startsWith('app/src/components/ui/')) return null;
  if (path.startsWith('app/src/')) return /\.test\.tsx?$/.test(path) ? 'webTests' : 'web';
  if (path.startsWith('app/build/') || path.startsWith('app/bin/') || path === 'app/vite.config.ts') return 'build';
  return null;
}

/** Newline count, as `wc -l`. */
export function countLines(text: string): number {
  let n = 0;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) n++;
  return n;
}

export function median(values: number[]): number {
  if (values.length === 0) throw new Error('median of no values');
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] as number;
  return sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] as number) + upper) / 2;
}

/** `owner/repo#123`, not inside a longer path. */
const UPSTREAM_REF = /(?<![\w./-])[A-Za-z0-9][\w.-]*\/[\w.-]+#\d+\b/g;

/** `owner/repo#123` references in a source text, with their 1-based line. */
export function upstreamRefs(text: string): { line: number; ref: string }[] {
  return text
    .split('\n')
    .flatMap((content, i) => [...content.matchAll(UPSTREAM_REF)].map((m) => ({ line: i + 1, ref: m[0] })));
}

export interface Measures {
  /** `git rev-parse --short HEAD`. */
  commit: string;
  /** ISO 8601. */
  date: string;
  /** `process.version`. */
  node: string;
  code: Record<Group, { files: number; lines: number }>;
  /** `app/src/lib/api.ts` and `app/src/lib/ws.ts`: the web's client layer. */
  webClientLayer: { files: number; lines: number };
  dependencies: {
    app: { dependencies: number; devDependencies: number };
    /** Packages named by `## <name> - <version> (<license>)` headings of the licenses file. */
    bundledIntoServer: string[];
  };
  output: {
    /** `app/.output`. */
    totalBytes: number;
    /** `app/.output/server`. */
    serverBytes: number;
    /** `app/.output/public`. */
    clientBytes: number;
    /** Sum of the gzip size of each `.js` and `.css` under `app/.output/public/assets`. */
    clientGzipBytes: number;
  };
  startupMs: { runs: number[]; median: number };
  shutdownMs: { runs: number[]; median: number };
  /** Wall time of one run of each command; null with `--skip-durations`. */
  durationsMs: { build: number; check: number; test: number } | null;
  workarounds: { file: string; line: number; ref: string }[];
}

/** Wall time of `pnpm <script>` from the repository root; a non-zero exit aborts. */
function timePnpm(script: string): number {
  const start = performance.now();
  const r = spawnSync('pnpm', [script], { cwd: ROOT, stdio: 'inherit' });
  const ms = performance.now() - start;
  if (r.status !== 0) throw new Error(`pnpm ${script} failed (${r.status ?? r.signal})`);
  return Math.round(ms);
}

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((f) => f !== '' && existsSync(join(ROOT, f)));
}

/** Every file under a directory, recursively, as absolute paths. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));
}

function bytesUnder(dir: string): number {
  return filesUnder(dir).reduce((sum, f) => sum + statSync(f).size, 0);
}

const LICENSE_HEADING = /^## (.+) - (\S+) \((.+)\)$/;

/** The packages named by the `## <name> - <version> (<license>)` headings of the licenses file. */
function bundledPackages(): string[] {
  const text = readFileSync(join(OUTPUT, 'server/THIRD-PARTY-LICENSES.md'), 'utf8');
  return text.split('\n').flatMap((line) => {
    const name = LICENSE_HEADING.exec(line)?.[1];
    return name === undefined ? [] : [name];
  });
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((done) => s.listen(0, '127.0.0.1', done));
  const port = (s.address() as { port: number }).port;
  await new Promise((done) => s.close(done));
  return port;
}

/** Resolves with the process's exit, or rejects after `ms`. */
function exitWithin(proc: ChildProcessByStdio<null, null, Readable>, exited: Promise<unknown>, ms: number) {
  return Promise.race([
    exited,
    sleep(ms, undefined, { ref: false }).then(() => {
      throw new Error(`the process did not exit within ${ms} ms of SIGTERM (pid ${proc.pid})`);
    }),
  ]);
}

/**
 * One launch of the production build, as a user starts it (from a fresh data dir, without `CI`, `TEST` and
 * `NODE_ENV`): the time from spawn to the first 200 of `/api/health`, then, with a `/ws` client that got its first
 * message, the time from SIGTERM to the exit.
 */
async function launchOnce(): Promise<{ startup: number; shutdown: number }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'llama-webui-measure-'));
  const port = await freePort();
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of ['CI', 'TEST', 'NODE_ENV']) delete env[k];
  const base = `http://127.0.0.1:${port}`;
  let ws: WebSocket | undefined;
  const start = performance.now();
  const proc = spawn(
    process.execPath,
    [LAUNCHER, '--host', '127.0.0.1', '--port', String(port), '--data-dir', dataDir],
    { cwd: dataDir, env, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let stderr = '';
  proc.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise<void>((done) => proc.once('exit', () => done()));
  try {
    let startup: number | undefined;
    while (startup === undefined) {
      if (proc.exitCode !== null || proc.signalCode !== null) {
        throw new Error(
          `the build exited (${proc.exitCode ?? proc.signalCode}) before /api/health answered:\n${stderr}`,
        );
      }
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) }).catch(() => null);
      if (res?.status === 200) startup = performance.now() - start;
      else if (performance.now() - start > STARTUP_TIMEOUT_MS) {
        throw new Error(`/api/health did not answer 200 within ${STARTUP_TIMEOUT_MS} ms:\n${stderr}`);
      } else await sleep(10);
    }
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws = socket;
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(() => fail(new Error('no message on /ws within 10 s')), 10_000);
      socket.addEventListener('message', () => {
        clearTimeout(timer);
        done();
      });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        fail(new Error('/ws failed'));
      });
    });
    const signalled = performance.now();
    proc.kill('SIGTERM');
    await exitWithin(proc, exited, SHUTDOWN_TIMEOUT_MS);
    const shutdown = performance.now() - signalled;
    return { startup: Math.round(startup), shutdown: Math.round(shutdown) };
  } finally {
    ws?.close();
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill('SIGKILL');
      await exited;
    }
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function measure(skipDurations: boolean): Promise<Measures> {
  let durationsMs: Measures['durationsMs'] = null;
  if (skipDurations) {
    if (!existsSync(LAUNCHER)) throw new Error('no build: run pnpm build first');
  } else {
    const build = timePnpm('build');
    const check = timePnpm('check');
    const test = timePnpm('test');
    durationsMs = { build, check, test };
  }

  const code = Object.fromEntries(GROUPS.map((g) => [g, { files: 0, lines: 0 }])) as Measures['code'];
  const webClientLayer = { files: 0, lines: 0 };
  const workarounds: Measures['workarounds'] = [];
  for (const file of trackedFiles()) {
    const group = classify(file);
    const isClientLayer = WEB_CLIENT_LAYER.includes(file);
    if (group === null && !isClientLayer) continue;
    const text = readFileSync(join(ROOT, file), 'utf8');
    const lines = countLines(text);
    if (group !== null) {
      code[group].files++;
      code[group].lines += lines;
    }
    if (isClientLayer) {
      webClientLayer.files++;
      webClientLayer.lines += lines;
    }
    if (group === 'server' || group === 'build') {
      for (const r of upstreamRefs(text)) workarounds.push({ file, ...r });
    }
  }

  const pkg = JSON.parse(readFileSync(join(ROOT, 'app/package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const dependencies: Measures['dependencies'] = {
    app: {
      dependencies: Object.keys(pkg.dependencies ?? {}).length,
      devDependencies: Object.keys(pkg.devDependencies ?? {}).length,
    },
    bundledIntoServer: bundledPackages(),
  };

  const output: Measures['output'] = {
    totalBytes: bytesUnder(OUTPUT),
    serverBytes: bytesUnder(join(OUTPUT, 'server')),
    clientBytes: bytesUnder(join(OUTPUT, 'public')),
    clientGzipBytes: filesUnder(join(OUTPUT, 'public/assets'))
      .filter((f) => f.endsWith('.js') || f.endsWith('.css'))
      .reduce((sum, f) => sum + gzipSync(readFileSync(f)).byteLength, 0),
  };

  const startup: number[] = [];
  const shutdown: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const run = await launchOnce();
    startup.push(run.startup);
    shutdown.push(run.shutdown);
  }

  return {
    commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    date: new Date().toISOString(),
    node: process.version,
    code,
    webClientLayer,
    dependencies,
    output,
    startupMs: { runs: startup, median: median(startup) },
    shutdownMs: { runs: shutdown, median: median(shutdown) },
    durationsMs,
    workarounds,
  };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { out: { type: 'string' }, 'skip-durations': { type: 'boolean', default: false } },
  });
  if (values.out === undefined) {
    console.error('usage: node scripts/poc/measure.ts --out <file.json> [--skip-durations]');
    process.exit(2);
  }
  const measures = await measure(values['skip-durations']);
  const out = resolve(values.out);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(measures, null, 2)}\n`);
  console.log(`wrote ${out}`);
}
