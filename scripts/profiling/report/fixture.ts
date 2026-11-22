// A small typed run, for the tests of the comparison and the report: a Dashboard (one clean window, one profiled),
// llama-server's throughput, one API route and the startup.
import { RESULTS_VERSION, type ProfileSummary, type Results, type ScenarioName, type Window } from '../results.ts';

export interface FixtureOverrides {
  /** CPU % by scenario, window id and process group */
  cpu?: { [S in ScenarioName]?: Record<string, Record<string, number>> };
  apiP50Ms?: number;
  without?: ScenarioName[];
  /** gpu_busy_percent of the one AMD card */
  gpuBusy?: number;
  failed?: Results['failed'];
  gpuCompositing?: string | null;
}

const profile = (activeMs: number): ProfileSummary => ({
  totalMs: 60_000,
  activeMs,
  gcMs: 12,
  byGroup: [
    { group: 'Node (internals)', ms: activeMs / 2 },
    { group: 'app: collectors', ms: activeMs / 4 },
  ],
  topSelf: [{ fn: 'readNvml', module: 'server/collectors/nvml/read.ts', line: 12, group: 'app: collectors', ms: 20 }],
  topInclusive: [{ fn: 'tick', module: 'server/monitor/Monitor.ts', line: 40, group: 'app: monitor', ms: 60 }],
});

function window(id: string, profiled: boolean, cpu: Record<string, number>, gpuBusy: number): Window {
  const groups = { server: 1.6, 'nvml-worker': 3.3, 'chrome-renderer': 3.1, 'chrome-gpu': 14.4, ...cpu };
  return {
    id,
    label: profiled ? 'Dashboard, profiled' : 'Dashboard, clean',
    profiled,
    serverUptimeS: 40,
    historyPoints: 30,
    procs: {
      wallMs: 60_000,
      cpuPct: groups,
      userPct: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v * 0.7])),
      sysPct: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v * 0.3])),
      threadPct: { 'server/node-MainThread': 1.2, 'chrome-gpu/VizCompositorTh': 6.5 },
      rssMb: { server: 180, 'nvml-worker': 60, 'chrome-renderer': 140, 'chrome-gpu': 210 },
      gpuBusyPct: { '0000:0d:00.0': gpuBusy },
    },
    eventLoopUtilization: profiled ? null : 0.012,
    page: {
      taskPct: 0.6,
      scriptPct: 0.2,
      layoutPct: 0.05,
      stylePct: 0.08,
      commitsPerSec: 1,
      longTasksMs: [],
      heapUsedMb: 24,
      nodes: 2100,
      listeners: 340,
    },
    ws: { seconds: 60, byType: { snapshot: { count: 60, bytes: 240_000 }, log: { count: 4, bytes: 900 } } },
    ...(profiled
      ? {
          serverProfile: profile(300),
          pageProfile: profile(110),
          census: {
            commits: 10,
            totalRenders: 140,
            components: [{ name: 'GpuCard', module: 'src/features/dashboard/GpuCard.tsx', renders: 20, perCommit: 2 }],
          },
        }
      : {}),
  };
}

export function fixtureResults(overrides: FixtureOverrides = {}): Results {
  const cpu = overrides.cpu?.dashboard ?? {};
  const gpuBusy = overrides.gpuBusy ?? 30;
  const scenarios: Results['scenarios'] = {
    startup: { startMs: [118, 116, 121], stopMs: [42, 40, 45], bareNodeMs: [30, 31, 29], launchProfile: profile(95) },
    dashboard: {
      windows: [
        window('clean', false, cpu.clean ?? {}, gpuBusy),
        window('profiled', true, cpu.profiled ?? {}, gpuBusy),
      ],
    },
    api: { routes: [{ url: '/api/health', firstMs: 0.4, p50Ms: overrides.apiP50Ms ?? 0.1, p95Ms: 0.2, bytes: 120 }] },
    tps: {
      modes: [
        { id: 'no-page', tokensPerSec: [72.1, 72.3, 72.0] },
        { id: 'dashboard', tokensPerSec: [71.8, 71.9, 72.0] },
        { id: 'static-page', tokensPerSec: [72.0, 72.1, 72.2] },
      ],
    },
  };
  for (const name of overrides.without ?? []) delete scenarios[name];
  return {
    version: RESULTS_VERSION,
    run: {
      name: 'fixture',
      startedAt: '2026-11-22T20:55:00.000Z',
      endedAt: '2026-11-22T21:05:00.000Z',
      scenarios: ['startup', 'dashboard', 'api', 'tps'],
      options: { host: '127.0.0.1', port: 7860, dataDir: null, profileId: 6, chrome: '/usr/bin/chromium', build: true },
      versions: { app: 'v0.4.3-5-gabcdef0', node: 'v26.13.0', chromium: '143.0.7499.40', kernel: '7.3.5-2-cachyos' },
      machine: { cpu: 'AMD Ryzen 9 7950X', threads: 32, memoryGb: 64, gpus: ['NVIDIA GeForce RTX 4090'] },
      profile: { id: 6, name: 'Qwen3.8-27B Q4_K_XL' },
      gpuCompositing: overrides.gpuCompositing === undefined ? 'enabled' : overrides.gpuCompositing,
      symbolicated: true,
    },
    scenarios,
    failed: overrides.failed ?? [],
  };
}
