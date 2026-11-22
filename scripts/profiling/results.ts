// The shape of a run's `results.json`: what the report renders and what a comparison joins. A change of meaning of any
// figure bumps `RESULTS_VERSION`, so that `--compare` refuses a reference whose numbers no longer mean the same thing.

export const RESULTS_VERSION = 1;

export const SCENARIO_NAMES = [
  'startup',
  'idle',
  'load',
  'launch',
  'dashboard',
  'soak',
  'aurora',
  'generation',
  'chat',
  'pages',
  'api',
  'tps',
  'collectors',
] as const;
export type ScenarioName = (typeof SCENARIO_NAMES)[number];

/** Per process group: server, nvml-worker, llama-server, chrome-browser, chrome-renderer, chrome-gpu, chrome-other. */
export interface ProcWindow {
  wallMs: number;
  /** % of one core */
  cpuPct: Record<string, number>;
  userPct: Record<string, number>;
  sysPct: Record<string, number>;
  /** `group/thread`, pool threads merged, < 0.05 dropped */
  threadPct: Record<string, number>;
  rssMb: Record<string, number>;
  /** AMD cards, by PCI address */
  gpuBusyPct: Record<string, number>;
}

export interface PageWindow {
  taskPct: number;
  scriptPct: number;
  layoutPct: number;
  stylePct: number;
  commitsPerSec: number;
  longTasksMs: number[];
  heapUsedMb: number;
  nodes: number;
  listeners: number;
}

export interface WsTraffic {
  seconds: number;
  byType: Record<string, { count: number; bytes: number }>;
}

export interface ProfileRow {
  fn: string;
  module: string;
  line: number;
  group: string;
  ms: number;
}

export interface ProfileSummary {
  totalMs: number;
  activeMs: number;
  gcMs: number;
  byGroup: { group: string; ms: number }[];
  topSelf: ProfileRow[];
  topInclusive: ProfileRow[];
}

export interface TraceSummary {
  framesPerSec: number;
  mainThreadPct: Record<string, number>;
}

export interface Census {
  commits: number;
  totalRenders: number;
  components: { name: string; module: string; renders: number; perCommit: number }[];
}

export interface Window {
  id: string;
  label: string;
  profiled: boolean;
  serverUptimeS: number;
  historyPoints: number;
  procs: ProcWindow;
  /** null under a profiler (the profiler inflates it) */
  eventLoopUtilization: number | null;
  page?: PageWindow;
  ws?: WsTraffic;
  serverProfile?: ProfileSummary;
  pageProfile?: ProfileSummary;
  trace?: TraceSummary;
  census?: Census;
}

export type ResourceKind = 'html' | 'js' | 'css' | 'font' | 'api' | 'other';

export interface PageLoad {
  cache: 'cold' | 'warm';
  ttfbMs: number;
  fcpMs: number;
  lcpMs: number;
  loadMs: number;
  scriptMs: number;
  firstSnapshotMs: number;
  requests: number;
  wireBytes: number;
  decodedBytes: number;
  byKind: Record<ResourceKind, { count: number; bytes: number }>;
}

export type TpsMode = 'no-page' | 'dashboard' | 'static-page';

export interface ScenarioResults {
  startup: { startMs: number[]; stopMs: number[]; bareNodeMs: number[]; launchProfile: ProfileSummary };
  /** clean, profiled */
  idle: { windows: Window[] };
  load: { loads: PageLoad[] };
  launch: { readyMs: number; logLines: number; windows: Window[] };
  /** clean (60 s), profiled (60 s, census), trace (20 s) */
  dashboard: { windows: Window[] };
  soak: {
    readings: { t: number; heapMb: number; nodes: number; listeners: number; serverRssMb: number }[];
    serverAfterGc: { start: { rssMb: number; heapMb: number }; end: { rssMb: number; heapMb: number } };
    /** soak (300 s) */
    windows: Window[];
  };
  /** window.id is the variant's id */
  aurora: { variants: { css: string; window: Window }[] };
  /** clean, profiled, trace */
  generation: { windows: Window[] };
  chat: {
    reply: { chars: number; tokens: number; tokensPerSec: number };
    /** by window id */
    spans: Record<string, { fromChars: number; toChars: number }>;
    /** trace, clean, profiled */
    windows: Window[];
  };
  pages: { pages: { path: string; load: PageLoad; window: Window; apiCalls: { url: string; ms: number }[] }[] };
  api: { routes: { url: string; firstMs: number; p50Ms: number; p95Ms: number; bytes: number }[] };
  tps: { modes: { id: TpsMode; tokensPerSec: number[] }[] };
  collectors: {
    nvml: {
      gpus: number;
      sampleCpuMs: number;
      sampleWallMs: number;
      calls: { call: string; cpuMs: number; wallMs: number }[];
    } | null;
    reads: { label: string; cpuMs: number; wallMs: number }[];
    skipped: string[];
  };
}

export interface RunInfo {
  name: string;
  startedAt: string;
  endedAt: string | null;
  scenarios: ScenarioName[];
  options: {
    host: string;
    port: number;
    dataDir: string | null;
    profileId: number | null;
    chrome: string;
    build: boolean;
  };
  versions: { app: string; node: string; chromium: string | null; kernel: string };
  machine: { cpu: string; threads: number; memoryGb: number; gpus: string[] };
  profile: { id: number; name: string } | null;
  /** Chromium's feature status; anything but 'enabled' is a warning */
  gpuCompositing: string | null;
  /** false with --no-build: page functions keep minified names */
  symbolicated: boolean;
}

export interface Results {
  version: typeof RESULTS_VERSION;
  run: RunInfo;
  scenarios: { [K in ScenarioName]?: ScenarioResults[K] };
  failed: { scenario: ScenarioName; error: string }[];
}

export function isScenarioName(value: string): value is ScenarioName {
  return (SCENARIO_NAMES as readonly string[]).includes(value);
}
