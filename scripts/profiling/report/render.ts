// The report of a run: one HTML document with no external resource, alone or against a reference run.
import type { Comparison } from '../compare.ts';
import { SCENARIOS } from '../options.ts';
import { type Results, SCENARIO_NAMES } from '../results.ts';
import { type Cell, makeCell, type Section } from './cell.ts';
import { table } from './charts.ts';
import { code, delta, esc, value } from './format.ts';
import { api } from './sections/api.ts';
import { aurora } from './sections/aurora.ts';
import { chat } from './sections/chat.ts';
import { collectors } from './sections/collectors.ts';
import { dashboard } from './sections/dashboard.ts';
import { generation } from './sections/generation.ts';
import { idle } from './sections/idle.ts';
import { launch } from './sections/launch.ts';
import { load } from './sections/load.ts';
import { method } from './sections/method.ts';
import { overview } from './sections/overview.ts';
import { pages } from './sections/pages.ts';
import { soak } from './sections/soak.ts';
import { startup } from './sections/startup.ts';
import { tps } from './sections/tps.ts';
import { CSS, SCRIPT } from './style.ts';

const BY_SCENARIO = {
  startup,
  idle,
  load,
  launch,
  dashboard,
  soak,
  aurora,
  generation,
  chat,
  pages,
  api,
  tps,
  collectors,
};

const TITLES: Record<string, string> = {
  changed: 'What changed',
  overview: 'Overview',
  startup: 'Startup',
  idle: 'Idle',
  load: 'Load',
  launch: 'Launch',
  dashboard: 'Dashboard',
  soak: 'Soak',
  aurora: 'Compositor',
  generation: 'Generation',
  chat: 'Chat',
  pages: 'Pages',
  api: 'API',
  tps: 'Throughput',
  collectors: 'Collectors',
  method: 'Method',
};

const date = (iso: string | null) => (iso === null ? 'not finished' : iso.replace('T', ' ').replace(/\.\d+Z$/, ' UTC'));

function header(results: Results): string {
  const { run } = results;
  const m = run.machine;
  const browser = run.scenarios.some((s) => SCENARIOS[s].needsBrowser);
  const banners: string[] = [];
  if (browser && run.gpuCompositing !== 'enabled')
    banners.push(
      `<div class="banner crit"><strong>Chromium composited in software rendering</strong> (GPU compositing: ${esc(run.gpuCompositing ?? 'unknown')}): the page and GPU-process figures do not stand for a desktop browser.</div>`,
    );
  if (!run.symbolicated)
    banners.push(
      '<div class="banner">Built with <code>--no-build</code>: the page’s functions keep their minified names.</div>',
    );
  if (results.failed.length > 0)
    banners.push(
      `<div class="banner crit"><strong>Failed scenarios</strong><ul>${results.failed.map((f) => `<li>${code(f.scenario)}: ${esc(f.error)}</li>`).join('')}</ul></div>`,
    );
  const rows: [string, string][] = [
    ['App', code(run.versions.app)],
    ['Measured', `${esc(date(run.startedAt))} to ${esc(date(run.endedAt))}`],
    ['Scenarios', run.scenarios.map(code).join(' ')],
    ['Model', run.profile ? `${esc(run.profile.name)} (profile ${String(run.profile.id)})` : 'none'],
    [
      'Machine',
      `${esc(m.cpu)}, ${String(m.threads)} threads, ${String(m.memoryGb)} GB; ${m.gpus.map(esc).join(', ') || 'no GPU listed'}`,
    ],
    [
      'Software',
      `Node ${esc(run.versions.node)}, Chromium ${esc(run.versions.chromium ?? 'not started')}, Linux ${esc(run.versions.kernel)}`,
    ],
  ];
  return `<header class="top">
<h1>llama-webui profiling: ${esc(run.name)}</h1>
<dl class="meta">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
${banners.join('\n')}
</header>`;
}

function changedSection(results: Results, comparison: Comparison): string {
  const rows = comparison.changed.map((f) => {
    const d = comparison.byId.get(f.id);
    return [
      `${esc(f.label)}${f.profiled ? '<span class="tag">profiled</span>' : ''}`,
      d ? esc(value(d.reference, f.kind)) : '—',
      esc(value(f.value, f.kind)),
      d ? `<span class="d changed">${esc(delta(d.delta, f.kind))}</span>` : '—',
    ];
  });
  const notes = comparison.notes.map((n) => `<li>${code(n.scenario)}: ${esc(n.note)}</li>`).join('');
  return `<section id="changed"><h2>What changed</h2>
<p class="muted">Against the run ${code(comparison.reference)}: the figures whose difference exceeds the noise threshold of their kind (see Method), largest first.</p>
${rows.length > 0 ? table(['Figure', 'Reference', 'This run', 'Difference'], rows, [1, 2, 3]) : '<p>No figure moved beyond its noise threshold.</p>'}
${notes === '' ? '' : `<h3>Notes</h3><ul>${notes}</ul>`}
${results.failed.length > 0 ? '<p>Failed scenarios of this run have no figures to compare.</p>' : ''}</section>`;
}

export function renderReport(results: Results, comparison: Comparison | null): string {
  const cell: Cell = makeCell(results, comparison);
  const parts: { id: string; html: string }[] = [];
  if (comparison) parts.push({ id: 'changed', html: changedSection(results, comparison) });
  const run = (id: string, s: Section) => {
    const html = s(results, cell);
    if (html !== null) parts.push({ id, html });
  };
  run('overview', overview);
  for (const name of SCENARIO_NAMES) if (results.scenarios[name] !== undefined) run(name, BY_SCENARIO[name]);
  run('method', method);
  const nav = parts.map((p) => `<a href="#${p.id}">${TITLES[p.id] ?? p.id}</a>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Profiling ${esc(results.run.name)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
${header(results)}
<nav aria-label="Sections">${nav}</nav>
${parts.map((p) => p.html).join('\n')}
</main>
<div id="tip" role="status"></div>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
