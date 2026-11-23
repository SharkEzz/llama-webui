// The command line of `pnpm profiling` and `pnpm profiling:report`, and the table of scenarios.
import { parseArgs } from 'node:util';
import { isScenarioName, SCENARIO_NAMES, type ScenarioName } from './results.ts';

export interface Options {
  command: 'run' | 'report' | 'list';
  scenarios: ScenarioName[];
  /** The run's folder under `.cache/profiling/` (for `report`, the run to rewrite) */
  name: string;
  compare: string | null;
  /** A git ref measured first, in a worktree, as the run `<name>.base` this one is compared with */
  base: string | null;
  profile: number | null;
  dataDir: string | null;
  host: string;
  port: number;
  chrome: string;
  build: boolean;
}

/** A mistake on the command line: printed with the usage, exit code 2. */
export class UsageError extends Error {
  override readonly name = 'UsageError';
}

export interface ScenarioInfo {
  needsModel: boolean;
  needsBrowser: boolean;
  minutes: number;
  summary: string;
}

export const SCENARIOS: Record<ScenarioName, ScenarioInfo> = {
  startup: {
    needsModel: false,
    needsBrowser: false,
    minutes: 1,
    summary: 'spawn to /api/health and SIGTERM to exit, five launches; one CPU profile of a launch',
  },
  idle: {
    needsModel: false,
    needsBrowser: false,
    minutes: 1,
    summary: 'the server and the NVML sampler with no page: CPU per process and thread, event loop',
  },
  load: {
    needsModel: false,
    needsBrowser: true,
    minutes: 1,
    summary: 'Dashboard load, cold and warm cache, three each: TTFB, FCP, LCP, script time, requests, bytes',
  },
  launch: {
    needsModel: true,
    needsBrowser: true,
    minutes: 1,
    summary: "the profile's start with the Dashboard open: time to ready, log lines, /ws messages, server CPU",
  },
  dashboard: {
    needsModel: true,
    needsBrowser: true,
    minutes: 3,
    summary: 'Dashboard at rest: a clean window, a profiled window (server and page), a trace, a census',
  },
  soak: {
    needsModel: true,
    needsBrowser: true,
    minutes: 6,
    summary: 'Dashboard open five minutes: JS heap after GC, DOM nodes, listeners, /ws traffic, server RSS and heap',
  },
  aurora: {
    needsModel: true,
    needsBrowser: true,
    minutes: 3,
    summary: 'the Dashboard under six CSS variants (aurora animation, backdrop blur, transitions)',
  },
  generation: {
    needsModel: true,
    needsBrowser: true,
    minutes: 3,
    summary: "the Dashboard while a reply is generated through the app's chat API",
  },
  chat: {
    needsModel: true,
    needsBrowser: true,
    minutes: 4,
    summary: 'the Chat page streaming a long Markdown reply: three successive windows, census, long tasks',
  },
  pages: {
    needsModel: true,
    needsBrowser: true,
    minutes: 5,
    summary: 'every page loaded cold then watched 12 s',
  },
  api: {
    needsModel: true,
    needsBrowser: true,
    minutes: 2,
    summary: 'every GET the pages make, replayed 20 times: p50, p95, size',
  },
  tps: {
    needsModel: true,
    needsBrowser: true,
    minutes: 3,
    summary: "llama-server's own throughput (fixed request and seed): no page, Dashboard, a static page",
  },
  collectors: {
    needsModel: true,
    needsBrowser: false,
    minutes: 1,
    summary: 'a breakdown, not a verdict: each NVML call and each /proc or sysfs read of a monitor tick',
  },
};

export const USAGE = `usage: pnpm profiling <scenario…|all> [--name <run>] [--compare <run> | --base <ref>] [--profile <id>]
                       [--data-dir <dir>] [--host <host>] [--port <port>] [--chrome <path>] [--no-build]
       pnpm profiling --list
       pnpm profiling:report <run> [--compare <run>]`;

const RUN_NAME = /^[\w.-]+$/;

/** The run a `--base` ref is measured as. */
export const baseRunName = (name: string): string => `${name}.base`;

function runName(value: string, what: string): string {
  if (!RUN_NAME.test(value)) throw new UsageError(`${what} must match [A-Za-z0-9._-]+: ${value}`);
  return value;
}

function stamp(now: Date): string {
  const two = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}`;
}

function integer(value: string, what: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new UsageError(`${what} must be a positive integer: ${value}`);
  return n;
}

export function parseOptions(argv: string[], now: Date): Options {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        list: { type: 'boolean' },
        name: { type: 'string' },
        compare: { type: 'string' },
        base: { type: 'string' },
        profile: { type: 'string' },
        'data-dir': { type: 'string' },
        host: { type: 'string' },
        port: { type: 'string' },
        chrome: { type: 'string' },
        'no-build': { type: 'boolean' },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  const options: Options = {
    command: 'run',
    scenarios: [],
    name: values.name === undefined ? stamp(now) : runName(values.name, '--name'),
    compare: values.compare === undefined ? null : runName(values.compare, '--compare'),
    base: values.base ?? null,
    profile: values.profile === undefined ? null : integer(values.profile, '--profile'),
    dataDir: values['data-dir'] ?? null,
    host: values.host ?? '127.0.0.1',
    port: values.port === undefined ? 7860 : integer(values.port, '--port'),
    chrome: values.chrome ?? '/usr/bin/chromium',
    build: values['no-build'] !== true,
  };
  if (values.list === true) return { ...options, command: 'list' };
  if (positionals[0] === 'report') {
    const [, run, ...rest] = positionals;
    if (run === undefined) throw new UsageError('report: name the run to rewrite');
    if (rest.length > 0) throw new UsageError(`report takes one run, got: ${positionals.slice(1).join(' ')}`);
    return { ...options, command: 'report', name: runName(run, 'the run') };
  }
  if (options.base !== null) {
    if (options.base === '' || options.base.startsWith('-'))
      throw new UsageError(`--base takes a git ref (a branch, a tag, a commit): ${options.base}`);
    if (options.compare !== null)
      throw new UsageError(
        '--base and --compare: one reference at a time, the base is the one the run is compared with',
      );
    if (!options.build) throw new UsageError('--base and --no-build: the base has no build to reuse');
  }
  if (positionals.length === 0) throw new UsageError(`name at least one scenario: ${SCENARIO_NAMES.join(', ')}, all`);
  const asked = new Set<ScenarioName>();
  for (const word of positionals) {
    if (word === 'all') for (const name of SCENARIO_NAMES) asked.add(name);
    else if (isScenarioName(word)) asked.add(word);
    else throw new UsageError(`unknown scenario ${word}: the scenarios are ${SCENARIO_NAMES.join(', ')}, all`);
  }
  return { ...options, scenarios: SCENARIO_NAMES.filter((name) => asked.has(name)) };
}

export function listScenarios(): string {
  const rows = SCENARIO_NAMES.map((name) => {
    const s = SCENARIOS[name];
    return `${name.padEnd(11)} ${(s.needsModel ? 'model' : '').padEnd(6)}${(s.needsBrowser ? 'browser' : '').padEnd(8)}${`${String(s.minutes)} min`.padEnd(7)}${s.summary}`;
  });
  return rows.join('\n');
}
