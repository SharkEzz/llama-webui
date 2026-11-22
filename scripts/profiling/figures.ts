// Every comparable number of a run, with a stable id: the comparison joins two runs on these ids, and the report
// prints a number only through its figure.
import type { PageLoad, Results, ScenarioName, Window } from './results.ts';

/** Units: % of one core, % of the main thread, tokens/s, ms, bytes, a plain number, %. */
export type FigureKind = 'cpu' | 'share' | 'tps' | 'duration' | 'size' | 'count' | 'gpuBusy';

export interface Figure {
  id: string;
  scenario: ScenarioName;
  label: string;
  value: number;
  kind: FigureKind;
  profiled: boolean;
  headline: boolean;
}

const MB = 1024 * 1024;
const HEADLINE_GROUPS = new Set(['server', 'nvml-worker', 'chrome-renderer', 'chrome-gpu']);

export const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = xs.toSorted((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
};
export const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

/** The windows of a run's scenario, whatever its shape. */
export function windowsOf(results: Results, scenario: ScenarioName): Window[] {
  const s = results.scenarios;
  switch (scenario) {
    case 'idle':
      return s.idle?.windows ?? [];
    case 'launch':
      return s.launch?.windows ?? [];
    case 'dashboard':
      return s.dashboard?.windows ?? [];
    case 'soak':
      return s.soak?.windows ?? [];
    case 'generation':
      return s.generation?.windows ?? [];
    case 'chat':
      return s.chat?.windows ?? [];
    case 'aurora':
      return s.aurora?.variants.map((v) => v.window) ?? [];
    case 'pages':
      return s.pages?.pages.map((p) => p.window) ?? [];
    default:
      return [];
  }
}

export const LOAD_FIELDS: { field: keyof PageLoad; label: string; kind: FigureKind }[] = [
  { field: 'ttfbMs', label: 'TTFB', kind: 'duration' },
  { field: 'fcpMs', label: 'FCP', kind: 'duration' },
  { field: 'lcpMs', label: 'LCP', kind: 'duration' },
  { field: 'loadMs', label: 'load event', kind: 'duration' },
  { field: 'scriptMs', label: 'script time', kind: 'duration' },
  { field: 'firstSnapshotMs', label: 'first snapshot', kind: 'duration' },
  { field: 'requests', label: 'requests', kind: 'count' },
  { field: 'wireBytes', label: 'bytes on the wire', kind: 'size' },
  { field: 'decodedBytes', label: 'decoded bytes', kind: 'size' },
];

function windowFigures(scenario: ScenarioName, w: Window, push: (f: Omit<Figure, 'scenario'>) => void): void {
  const p = `${scenario}.${w.id}`;
  const at = w.label;
  const base = { profiled: w.profiled, headline: false };
  for (const [group, v] of Object.entries(w.procs.cpuPct))
    push({
      ...base,
      id: `${p}.cpu.${group}`,
      label: `${at}: CPU ${group}`,
      value: v,
      kind: 'cpu',
      headline: !w.profiled && HEADLINE_GROUPS.has(group),
    });
  for (const [group, v] of Object.entries(w.procs.userPct))
    push({ ...base, id: `${p}.user.${group}`, label: `${at}: user CPU ${group}`, value: v, kind: 'cpu' });
  for (const [group, v] of Object.entries(w.procs.sysPct))
    push({ ...base, id: `${p}.sys.${group}`, label: `${at}: system CPU ${group}`, value: v, kind: 'cpu' });
  for (const [thread, v] of Object.entries(w.procs.threadPct))
    push({ ...base, id: `${p}.thread.${thread}`, label: `${at}: thread ${thread}`, value: v, kind: 'cpu' });
  for (const [group, v] of Object.entries(w.procs.rssMb))
    push({ ...base, id: `${p}.rss.${group}`, label: `${at}: RSS ${group}`, value: v * MB, kind: 'size' });
  for (const [card, v] of Object.entries(w.procs.gpuBusyPct))
    push({ ...base, id: `${p}.gpu.${card}`, label: `${at}: gpu_busy_percent ${card}`, value: v, kind: 'gpuBusy' });
  if (w.eventLoopUtilization !== null)
    push({
      ...base,
      id: `${p}.elu`,
      label: `${at}: server event loop utilization`,
      value: w.eventLoopUtilization * 100,
      kind: 'share',
    });
  if (w.page) {
    const pg = w.page;
    const page: [string, string, number, FigureKind][] = [
      ['taskPct', 'page tasks', pg.taskPct, 'share'],
      ['scriptPct', 'page script', pg.scriptPct, 'share'],
      ['layoutPct', 'page layout', pg.layoutPct, 'share'],
      ['stylePct', 'page style', pg.stylePct, 'share'],
      ['commitsPerSec', 'React commits per second', pg.commitsPerSec, 'count'],
      ['longTasks', 'long tasks', pg.longTasksMs.length, 'count'],
      ['longTasksMs', 'long tasks, total', pg.longTasksMs.reduce((a, b) => a + b, 0), 'duration'],
      ['heapUsedMb', 'JS heap', pg.heapUsedMb * MB, 'size'],
      ['nodes', 'DOM nodes', pg.nodes, 'count'],
      ['listeners', 'event listeners', pg.listeners, 'count'],
    ];
    for (const [field, label, value, kind] of page)
      push({ ...base, id: `${p}.page.${field}`, label: `${at}: ${label}`, value, kind });
  }
  if (w.ws && w.ws.seconds > 0)
    for (const [type, t] of Object.entries(w.ws.byType))
      push({
        ...base,
        id: `${p}.ws.${type}.bytesPerSec`,
        label: `${at}: /ws ${type} bytes per second`,
        value: t.bytes / w.ws.seconds,
        kind: 'size',
      });
  if (w.serverProfile)
    push({
      ...base,
      id: `${p}.profile.server.activeMs`,
      label: `${at}: server profile, active`,
      value: w.serverProfile.activeMs,
      kind: 'duration',
    });
  if (w.pageProfile)
    push({
      ...base,
      id: `${p}.profile.page.activeMs`,
      label: `${at}: page profile, active`,
      value: w.pageProfile.activeMs,
      kind: 'duration',
    });
  if (w.census)
    push({
      ...base,
      id: `${p}.census.rendersPerCommit`,
      label: `${at}: component renders per commit`,
      value: w.census.commits > 0 ? w.census.totalRenders / w.census.commits : 0,
      kind: 'count',
    });
  if (w.trace)
    push({
      ...base,
      id: `${p}.trace.framesPerSec`,
      label: `${at}: frames drawn per second`,
      value: w.trace.framesPerSec,
      kind: 'count',
    });
}

export function figures(results: Results): Figure[] {
  const out: Figure[] = [];
  const s = results.scenarios;
  const add = (scenario: ScenarioName) => (f: Omit<Figure, 'scenario'>) => out.push({ ...f, scenario });
  const plain = { profiled: false, headline: false };
  if (s.startup) {
    const push = add('startup');
    push({
      ...plain,
      id: 'startup.startMs',
      label: 'start to /api/health (median)',
      value: median(s.startup.startMs),
      kind: 'duration',
      headline: true,
    });
    push({
      ...plain,
      id: 'startup.stopMs',
      label: 'SIGTERM to exit (median)',
      value: median(s.startup.stopMs),
      kind: 'duration',
    });
    push({
      ...plain,
      id: 'startup.bareNodeMs',
      label: 'bare Node start (median)',
      value: median(s.startup.bareNodeMs),
      kind: 'duration',
    });
    push({
      id: 'startup.profile.activeMs',
      label: 'profiled launch, active',
      value: s.startup.launchProfile.activeMs,
      kind: 'duration',
      profiled: true,
      headline: false,
    });
  }
  if (s.load) {
    const push = add('load');
    for (const cache of ['cold', 'warm'] as const) {
      const loads = s.load.loads.filter((l) => l.cache === cache);
      if (loads.length === 0) continue;
      for (const { field, label, kind } of LOAD_FIELDS)
        push({
          ...plain,
          id: `load.${cache}.${field}`,
          label: `Dashboard load, ${cache} cache: ${label} (median)`,
          value: median(loads.map((l) => Number(l[field]))),
          kind,
          headline: field === 'fcpMs',
        });
    }
  }
  if (s.launch) {
    const push = add('launch');
    push({
      ...plain,
      id: 'launch.readyMs',
      label: 'profile start to ready',
      value: s.launch.readyMs,
      kind: 'duration',
      headline: true,
    });
    push({
      ...plain,
      id: 'launch.logLines',
      label: 'log lines during the start',
      value: s.launch.logLines,
      kind: 'count',
    });
  }
  if (s.soak) {
    const push = add('soak');
    const last = s.soak.readings.at(-1);
    if (last) {
      push({
        ...plain,
        id: 'soak.heapMb.end',
        label: 'page JS heap after GC, end',
        value: last.heapMb * MB,
        kind: 'size',
      });
      push({ ...plain, id: 'soak.nodes.end', label: 'DOM nodes, end', value: last.nodes, kind: 'count' });
      push({ ...plain, id: 'soak.listeners.end', label: 'event listeners, end', value: last.listeners, kind: 'count' });
    }
    const gc = s.soak.serverAfterGc;
    push({
      ...plain,
      id: 'soak.server.rssAfterGc',
      label: 'server RSS after GC, end',
      value: gc.end.rssMb * MB,
      kind: 'size',
    });
    push({
      ...plain,
      id: 'soak.server.heapAfterGc',
      label: 'server heap after GC, end',
      value: gc.end.heapMb * MB,
      kind: 'size',
    });
    push({
      ...plain,
      id: 'soak.server.rssGrowth',
      label: 'server RSS after GC, growth over the soak',
      value: (gc.end.rssMb - gc.start.rssMb) * MB,
      kind: 'size',
    });
  }
  if (s.chat) {
    const push = add('chat');
    push({
      ...plain,
      id: 'chat.reply.tokensPerSec',
      label: 'chat reply tokens per second',
      value: s.chat.reply.tokensPerSec,
      kind: 'tps',
    });
  }
  if (s.pages)
    for (const page of s.pages.pages)
      for (const { field, label, kind } of LOAD_FIELDS)
        add('pages')({
          ...plain,
          id: `pages.${page.path}.${field}`,
          label: `${page.path}: ${label}`,
          value: Number(page.load[field]),
          kind,
        });
  if (s.api)
    for (const r of s.api.routes) {
      const push = add('api');
      push({ ...plain, id: `api.${r.url}.firstMs`, label: `${r.url}: first`, value: r.firstMs, kind: 'duration' });
      push({ ...plain, id: `api.${r.url}.p50Ms`, label: `${r.url}: p50`, value: r.p50Ms, kind: 'duration' });
      push({ ...plain, id: `api.${r.url}.p95Ms`, label: `${r.url}: p95`, value: r.p95Ms, kind: 'duration' });
      push({ ...plain, id: `api.${r.url}.bytes`, label: `${r.url}: size`, value: r.bytes, kind: 'size' });
    }
  if (s.tps)
    for (const m of s.tps.modes)
      add('tps')({
        ...plain,
        id: `tps.${m.id}.tokensPerSec`,
        label: `llama-server tokens per second, ${m.id} (mean)`,
        value: mean(m.tokensPerSec),
        kind: 'tps',
        headline: true,
      });
  if (s.collectors) {
    const push = add('collectors');
    const { nvml } = s.collectors;
    if (nvml) {
      push({
        ...plain,
        id: 'collectors.nvml.sampleCpuMs',
        label: 'NVML sample, CPU',
        value: nvml.sampleCpuMs,
        kind: 'duration',
      });
      for (const c of nvml.calls)
        push({
          ...plain,
          id: `collectors.nvml.${c.call}.cpuMs`,
          label: `NVML ${c.call}, CPU`,
          value: c.cpuMs,
          kind: 'duration',
        });
    }
    for (const r of s.collectors.reads)
      push({
        ...plain,
        id: `collectors.read.${r.label}.cpuMs`,
        label: `read ${r.label}, CPU`,
        value: r.cpuMs,
        kind: 'duration',
      });
  }
  for (const scenario of ['idle', 'launch', 'dashboard', 'soak', 'aurora', 'generation', 'chat', 'pages'] as const)
    for (const w of windowsOf(results, scenario)) windowFigures(scenario, w, add(scenario));
  return out;
}
