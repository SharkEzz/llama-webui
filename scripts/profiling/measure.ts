// One measure window: /proc for every process of the server and of Chromium, the server's event loop (and its CPU
// profile on request) through its inspector, and the page's metrics, /ws frames, profile or trace when there is one.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, Page } from 'puppeteer-core';
import { parseCpuProfile, summarizeProfile } from './analyze/cpuprofile.ts';
import { clientOrigins, serverOrigins } from './analyze/origins.ts';
import { summarizeTrace } from './analyze/trace.ts';
import { type Instance, now, SERVER_BUNDLE, sleep } from './instance.ts';
import { arr, isRecord, num } from './json.ts';
import type { Options } from './options.ts';
import { watchProcs } from './procs.ts';
import type { PageWindow, ScenarioName, ScenarioResults, Window, WsTraffic } from './results.ts';
import type { RunDir } from './run-dir.ts';

export interface Context {
  run: RunDir;
  options: Options;
  instance: Instance;
  browser: Browser | null;
  scenario: ScenarioName;
  log: (line: string) => void;
}

export interface Scenario<K extends ScenarioName> {
  name: K;
  run: (ctx: Context) => Promise<ScenarioResults[K]>;
}

export interface WindowOptions {
  id: string;
  label: string;
  ms: number;
  /** CPU profiles of the server and of the page */
  profile?: boolean;
  /** a Chromium trace of the page */
  trace?: boolean;
  /** /ws frames by message type */
  ws?: boolean;
  /** started once the window is open; the window lasts until both it and `ms` are over */
  during?: () => Promise<unknown>;
}

/** The run's source maps of the client, null with --no-build (page functions keep minified names). */
export function sourcemaps(ctx: Context): string | null {
  const maps = ctx.run.file('sourcemaps');
  return existsSync(maps) ? maps : null;
}

/** The folder of a scenario's raw data. */
export function dataDir(ctx: Context): string {
  const dir = ctx.run.file('data', ctx.scenario);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const SAMPLING_US = 250;
const TRACE_CATEGORIES = [
  '-*',
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'v8',
  'blink.user_timing',
];

const SERVER_BEGIN = `(() => {
  const ph = process.getBuiltinModule('node:perf_hooks');
  globalThis.__profiling = { ph, elu: ph.performance.eventLoopUtilization() };
  return true;
})()`;
const SERVER_END = `(() => {
  const p = globalThis.__profiling;
  return p.ph.performance.eventLoopUtilization(p.elu).utilization;
})()`;

const METRICS = new Set([
  'TaskDuration',
  'ScriptDuration',
  'LayoutDuration',
  'RecalcStyleDuration',
  'JSHeapUsedSize',
  'Nodes',
  'JSEventListeners',
]);

/** The counters the page's init script keeps (browser.ts): React commits and long tasks. */
async function pageCounters(
  page: Page,
): Promise<{ commits: number; longTasks: { start: number; dur: number }[]; t: number }> {
  const raw: unknown = await page.evaluate('({ prof: window.__profiling ?? null, t: performance.now() })');
  const prof = isRecord(raw) && isRecord(raw.prof) ? raw.prof : {};
  return {
    commits: num(prof.commits),
    longTasks: arr(prof.longTasks).flatMap((l) => (isRecord(l) ? [{ start: num(l.start), dur: num(l.dur) }] : [])),
    t: isRecord(raw) ? num(raw.t) : 0,
  };
}

/** The type of a /ws message, read without decoding the whole payload. */
const wsType = (payload: string) => /"type":"([^"]+)"/.exec(payload)?.[1] ?? '(other)';

export async function measure(ctx: Context, page: Page | null, options: WindowOptions): Promise<Window> {
  const { instance } = ctx;
  const dir = dataDir(ctx);
  const profile = options.profile === true;
  const session = page ? await page.createCDPSession() : null;
  const frames: { type: string; bytes: number }[] = [];
  if (session) {
    await session.send('Performance.enable');
    if (options.ws === true) {
      await session.send('Network.enable');
      session.on('Network.webSocketFrameReceived', (ev) => {
        const data = ev.response.payloadData;
        frames.push({ type: wsType(data), bytes: data.length });
      });
    }
    if (profile) {
      await session.send('Profiler.enable');
      await session.send('Profiler.setSamplingInterval', { interval: SAMPLING_US });
    }
  }
  const tracePath = join(dir, `${options.id}.trace.json`);
  if (page && options.trace === true) await page.tracing.start({ path: tracePath, categories: TRACE_CATEGORIES });
  const serverUptimeS = await instance.uptimeS();
  const historyPoints = await instance.historyPoints();
  const metrics = async () => {
    if (!session) return null;
    const { metrics: list } = await session.send('Performance.getMetrics');
    return new Map(list.filter((m) => METRICS.has(m.name)).map((m) => [m.name, m.value]));
  };
  const before = await metrics();
  const countersBefore = page ? await pageCounters(page) : null;
  const inspector = instance.inspector;
  await inspector.evaluate(SERVER_BEGIN);
  if (profile) {
    await inspector.send('Profiler.enable');
    await inspector.send('Profiler.setSamplingInterval', { interval: SAMPLING_US });
    await inspector.send('Profiler.start');
  }
  if (session && profile) await session.send('Profiler.start');
  const procs = watchProcs({ server: instance.serverPid, chrome: ctx.browser?.process()?.pid ?? null });
  const t0 = now();

  try {
    await Promise.all([sleep(options.ms), options.during?.()]);
  } catch (error) {
    // Leave nothing running for the next window: profilers, trace, the page session.
    procs.stop();
    const quiet = (p: Promise<unknown> | undefined) => p?.catch(() => undefined);
    await quiet(session && profile ? session.send('Profiler.stop') : undefined);
    await quiet(profile ? inspector.send('Profiler.stop') : undefined);
    await quiet(page && options.trace === true ? page.tracing.stop() : undefined);
    await quiet(session?.detach());
    throw error;
  }

  const wallMs = now() - t0;
  const procWindow = procs.stop();
  // Every profiler is stopped before anything is summarized, so that a summary that throws leaves none running.
  const pageRaw: unknown = session && profile ? (await session.send('Profiler.stop')).profile : null;
  const serverStopped = profile ? await inspector.send('Profiler.stop') : null;
  const serverRaw = isRecord(serverStopped) ? serverStopped.profile : null;
  const window: Window = {
    id: options.id,
    label: options.label,
    // A trace costs the page as a profiler does: its figures compare only with another profiled window.
    profiled: profile || options.trace === true,
    serverUptimeS,
    historyPoints,
    procs: procWindow,
    eventLoopUtilization: null,
  };
  if (pageRaw !== null) writeFileSync(join(dir, `${options.id}.page.cpuprofile`), JSON.stringify(pageRaw));
  if (serverRaw !== null) writeFileSync(join(dir, `${options.id}.server.cpuprofile`), JSON.stringify(serverRaw));
  const elu = num(await inspector.evaluate(SERVER_END));
  // A profiler inflates the event loop's busy time: only a clean window reports it.
  if (!profile) window.eventLoopUtilization = elu;
  const after = await metrics();
  const countersAfter = page ? await pageCounters(page) : null;
  if (page && options.trace === true) await page.tracing.stop();
  if (session) await session.detach();
  if (pageRaw !== null) window.pageProfile = summarizeProfile(parseCpuProfile(pageRaw), clientOrigins(sourcemaps(ctx)));
  if (serverRaw !== null)
    window.serverProfile = summarizeProfile(parseCpuProfile(serverRaw), serverOrigins(SERVER_BUNDLE));
  if (page && options.trace === true) window.trace = summarizeTrace(tracePath);
  if (before && after && countersBefore && countersAfter) {
    const d = (k: string) => (after.get(k) ?? 0) - (before.get(k) ?? 0);
    const sec = wallMs / 1000;
    const pageWindow: PageWindow = {
      taskPct: (d('TaskDuration') / sec) * 100,
      scriptPct: (d('ScriptDuration') / sec) * 100,
      layoutPct: (d('LayoutDuration') / sec) * 100,
      stylePct: (d('RecalcStyleDuration') / sec) * 100,
      commitsPerSec: (countersAfter.commits - countersBefore.commits) / sec,
      longTasksMs: countersAfter.longTasks.filter((l) => l.start >= countersBefore.t).map((l) => l.dur),
      heapUsedMb: (after.get('JSHeapUsedSize') ?? 0) / 2 ** 20,
      nodes: after.get('Nodes') ?? 0,
      listeners: after.get('JSEventListeners') ?? 0,
    };
    window.page = pageWindow;
  }
  if (options.ws === true) {
    const ws: WsTraffic = { seconds: wallMs / 1000, byType: {} };
    for (const f of frames) {
      const b = (ws.byType[f.type] ??= { count: 0, bytes: 0 });
      b.count++;
      b.bytes += f.bytes;
    }
    window.ws = ws;
  }
  writeFileSync(join(dir, `${options.id}.window.json`), `${JSON.stringify(window, null, 2)}\n`);
  return window;
}
