// The blocks every window-based section shares: processes, threads, page, /ws, profiles, census, trace.
import type { ProfileSummary, ScenarioName, Window } from '../../results.ts';
import type { Cell } from '../cell.ts';
import { bars, details, SERIES, table, tiles } from '../charts.ts';
import { bytes, code, esc, ms, num, pct } from '../format.ts';

export const MAIN_GROUPS = ['server', 'nvml-worker', 'chrome-renderer', 'chrome-gpu'] as const;
export const GROUP_LABEL: Record<string, string> = {
  server: 'server',
  'nvml-worker': 'NVML sampler',
  'llama-server': 'llama-server',
  'chrome-browser': 'Chromium browser',
  'chrome-renderer': 'page renderer',
  'chrome-gpu': 'Chromium GPU process',
  'chrome-other': 'Chromium, other',
  'nvidia-smi': 'nvidia-smi',
  other: 'other',
};
export const groupLabel = (g: string): string => GROUP_LABEL[g] ?? g;

export const section = (id: string, title: string, intro: string, body: string): string =>
  `<section id="${esc(id)}"><h2>${esc(title)}</h2><p class="muted">${intro}</p>${body}</section>`;

/** CPU (total, user, system) and RSS per process group. */
function procTable(prefix: string, w: Window, cell: Cell): string {
  const groups = Object.keys(w.procs.cpuPct).toSorted((a, b) => (w.procs.cpuPct[b] ?? 0) - (w.procs.cpuPct[a] ?? 0));
  return table(
    ['Process', 'CPU', 'user', 'system', 'RSS'],
    groups.map((g) => [
      esc(groupLabel(g)),
      cell(`${prefix}.cpu.${g}`),
      cell(`${prefix}.user.${g}`),
      cell(`${prefix}.sys.${g}`),
      cell(`${prefix}.rss.${g}`),
    ]),
    [1, 2, 3, 4],
  );
}

function threadTable(prefix: string, w: Window, cell: Cell): string {
  const threads = Object.keys(w.procs.threadPct)
    .toSorted((a, b) => (w.procs.threadPct[b] ?? 0) - (w.procs.threadPct[a] ?? 0))
    .slice(0, 15);
  return table(
    ['Thread', 'CPU'],
    threads.map((t) => [code(t), cell(`${prefix}.thread.${t}`)]),
    [1],
  );
}

function pageTable(prefix: string, w: Window, cell: Cell): string {
  if (!w.page) return '';
  const rows: [string, string][] = [
    ['page tasks (main thread)', 'taskPct'],
    ['script', 'scriptPct'],
    ['layout', 'layoutPct'],
    ['style', 'stylePct'],
    ['React commits per second', 'commitsPerSec'],
    ['long tasks', 'longTasks'],
    ['long tasks, total', 'longTasksMs'],
    ['JS heap', 'heapUsedMb'],
    ['DOM nodes', 'nodes'],
    ['event listeners', 'listeners'],
  ];
  return table(
    ['Page', 'Value'],
    rows.map(([label, field]) => [esc(label), cell(`${prefix}.page.${field}`)]),
    [1],
  );
}

function wsTable(prefix: string, w: Window, cell: Cell): string {
  if (!w.ws || w.ws.seconds <= 0) return '';
  const { seconds, byType } = w.ws;
  const types = Object.keys(byType).toSorted((a, b) => (byType[b]?.bytes ?? 0) - (byType[a]?.bytes ?? 0));
  return table(
    ['/ws message', 'Messages', 'Per second', 'Mean size', 'Bytes per second'],
    types.map((t) => {
      const x = byType[t] ?? { count: 0, bytes: 0 };
      return [
        code(t),
        num(x.count),
        num(x.count / seconds, 2),
        x.count > 0 ? bytes(x.bytes / x.count) : '—',
        cell(`${prefix}.ws.${t}.bytesPerSec`),
      ];
    }),
    [1, 2, 3, 4],
  );
}

/** A CPU profile: active time by origin, then its costliest functions (self, and inclusive for app code). */
export function profileBlock(title: string, p: ProfileSummary, activeCell: string): string {
  const active = p.activeMs > 0 ? p.activeMs : 1;
  const groups = p.byGroup.filter((g) => g.ms > 0).slice(0, 12);
  const rows = (list: ProfileSummary['topSelf']) =>
    list
      .slice(0, 20)
      .map((f) => [
        esc(f.fn || '(anonymous)'),
        `${code(f.module)}${f.line > 0 ? `:${String(f.line)}` : ''}`,
        esc(f.group),
        ms(f.ms),
      ]);
  return `<h4>${esc(title)}</h4>
${tiles([
  { label: 'active (not idle)', value: activeCell },
  { label: 'garbage collector', value: ms(p.gcMs) },
  { label: 'profile length', value: ms(p.totalMs) },
])}
<figure>${bars(
    groups.map((g) => ({
      label: g.group,
      value: (g.ms / active) * 100,
      text: pct((g.ms / active) * 100, 0),
      tip: ms(g.ms),
    })),
    { title: `${title}: active time by origin`, color: SERIES[2] },
  )}<figcaption>Share of the active time by origin of the function that ran (self time).</figcaption></figure>
${details('Costliest functions, self time', table(['Function', 'Module', 'Origin', 'Self'], rows(p.topSelf), [3]))}
${details('Costliest app functions, inclusive time', table(['Function', 'Module', 'Origin', 'Inclusive'], rows(p.topInclusive), [3]))}`;
}

function censusBlock(prefix: string, w: Window, cell: Cell): string {
  const c = w.census;
  if (!c) return '';
  return `<h4>Rendered components</h4>
<p>${num(c.commits)} React commits, ${num(c.totalRenders)} component renders: ${cell(`${prefix}.census.rendersPerCommit`)} per commit.</p>
${details(
  'Components by renders',
  table(
    ['Component', 'Module', 'Renders', 'Per commit'],
    c.components.slice(0, 25).map((x) => [esc(x.name), code(x.module), num(x.renders), num(x.perCommit, 2)]),
    [2, 3],
  ),
)}`;
}

function traceBlock(prefix: string, w: Window, cell: Cell): string {
  const t = w.trace;
  if (!t) return '';
  const cats = Object.entries(t.mainThreadPct).toSorted((a, b) => b[1] - a[1]);
  return `<h4>Trace</h4>
<p>Frames drawn per second: ${cell(`${prefix}.trace.framesPerSec`)}.</p>
${table(
  ['Main thread (renderer)', 'Share of the window'],
  cats.map(([k, v]) => [esc(k), pct(v, 2)]),
  [1],
)}`;
}

/** Everything a window measured, under an h3 with its label. */
export function windowBlock(scenario: ScenarioName, w: Window, cell: Cell): string {
  const prefix = `${scenario}.${w.id}`;
  const tags = [
    w.profiled ? '<span class="tag">under a profiler</span>' : '',
    `<span class="tag">${num(w.procs.wallMs / 1000)} s</span>`,
    `<span class="tag">server up ${num(w.serverUptimeS)} s, ${num(w.historyPoints)} history points</span>`,
  ].join('');
  const main = MAIN_GROUPS.filter((g) => w.procs.cpuPct[g] !== undefined).map((g) => ({
    label: `CPU, ${groupLabel(g)}`,
    value: cell(`${prefix}.cpu.${g}`),
  }));
  if (w.eventLoopUtilization !== null) main.push({ label: 'server event loop', value: cell(`${prefix}.elu`) });
  const gpus = Object.keys(w.procs.gpuBusyPct).map((card) => ({
    label: `gpu_busy_percent ${esc(card)}`,
    value: cell(`${prefix}.gpu.${card}`),
  }));
  const profiles = [
    w.serverProfile
      ? profileBlock('Server CPU profile', w.serverProfile, cell(`${prefix}.profile.server.activeMs`))
      : '',
    w.pageProfile ? profileBlock('Page CPU profile', w.pageProfile, cell(`${prefix}.profile.page.activeMs`)) : '',
  ].join('');
  return `<h3>${esc(w.label)}${tags}</h3>
${tiles([...main, ...gpus])}
${details('CPU and memory by process', procTable(prefix, w, cell))}
${details('CPU by thread', threadTable(prefix, w, cell))}
${pageTable(prefix, w, cell)}
${details('/ws traffic', wsTable(prefix, w, cell))}
${traceBlock(prefix, w, cell)}
${censusBlock(prefix, w, cell)}
${profiles}`;
}

export const windowsBlock = (scenario: ScenarioName, windows: Window[], cell: Cell): string =>
  windows.map((w) => windowBlock(scenario, w, cell)).join('\n');
