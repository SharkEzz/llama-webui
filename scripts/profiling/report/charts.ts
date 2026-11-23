// Inline SVG charts and the HTML blocks of the report.
import { esc, num } from './format.ts';

export const SERIES = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)'] as const;

export interface Bar {
  label: string;
  value: number;
  /** what the tip shows after the label */
  text: string;
  tip?: string;
}

/** Horizontal bars, one series: label, bar, value at the tip. */
export function bars(rows: Bar[], opts: { title: string; color?: string; labelWidth?: number }): string {
  if (rows.length === 0) return '';
  const lw = opts.labelWidth ?? 260;
  const width = 860;
  const rowH = 30;
  const plot = width - lw - 170;
  const top = Math.max(...rows.map((r) => r.value));
  const max = top > 0 ? top * 1.05 : 1;
  const h = rows.length * rowH + 8;
  const body = rows
    .map((r, i) => {
      const y = i * rowH + 6;
      const w = Math.max(1, (Math.max(0, r.value) / max) * plot);
      const tip = `${r.label}: ${r.text}${r.tip === undefined ? '' : ` (${r.tip})`}`;
      return `<g class="mark" tabindex="0" data-tip="${esc(tip)}">
  <rect x="0" y="${String(y - 4)}" width="${String(width)}" height="${String(rowH)}" fill="transparent"/>
  <text x="${String(lw - 10)}" y="${String(y + 13)}" text-anchor="end" class="lab">${esc(r.label)}</text>
  <rect x="${String(lw)}" y="${String(y + 2)}" width="${w.toFixed(1)}" height="14" rx="4" fill="${opts.color ?? SERIES[0]}"/>
  <text x="${(lw + w + 8).toFixed(1)}" y="${String(y + 13)}" class="val">${esc(r.text)}</text>
</g>`;
    })
    .join('\n');
  return `<div class="scroll"><svg class="chart wide" viewBox="0 0 ${String(width)} ${String(h)}" role="img" aria-label="${esc(opts.title)}">
<line x1="${String(lw)}" y1="0" x2="${String(lw)}" y2="${String(h)}" class="axis"/>
${body}
</svg></div>`;
}

function niceTicks(max: number): number[] {
  const step = [0.5, 1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000].find((s) => max / s <= 6) ?? 5000;
  const out: number[] = [];
  for (let t = 0; t <= max; t += step) out.push(t);
  return out;
}

/** Stacked horizontal bars: one row per window, one segment per series, the total at the tip. */
export function stacked(
  rows: { label: string; parts: number[]; total: string }[],
  series: string[],
  opts: { title: string; format: (v: number) => string },
): string {
  if (rows.length === 0) return '';
  const lw = 320;
  const width = 920;
  const rowH = 32;
  const plot = width - lw - 110;
  const top = Math.max(...rows.map((r) => r.parts.reduce((a, b) => a + b, 0)));
  const max = top > 0 ? top * 1.04 : 1;
  const ticks = niceTicks(max);
  const h = rows.length * rowH + 30;
  const x = (v: number) => lw + (v / max) * plot;
  const grid = ticks
    .map(
      (t) =>
        `<line x1="${x(t).toFixed(1)}" y1="0" x2="${x(t).toFixed(1)}" y2="${String(h - 24)}" class="grid"/><text x="${x(t).toFixed(1)}" y="${String(h - 8)}" text-anchor="middle" class="tick">${num(t, t % 1 === 0 ? 0 : 1)}</text>`,
    )
    .join('');
  const body = rows
    .map((r, i) => {
      const y = i * rowH + 6;
      let acc = 0;
      const segs = r.parts
        .map((v, k) => {
          const x0 = x(acc);
          acc += Math.max(0, v);
          const w = Math.max(0, x(acc) - x0 - 2);
          if (w <= 0.5) return '';
          const tip = `${r.label}, ${series[k] ?? ''}: ${opts.format(v)}`;
          return `<rect class="mark" tabindex="0" x="${x0.toFixed(1)}" y="${String(y + 2)}" width="${w.toFixed(1)}" height="14" rx="4" fill="${SERIES[k] ?? ''}" data-tip="${esc(tip)}"/>`;
        })
        .join('');
      return `<text x="${String(lw - 10)}" y="${String(y + 13)}" text-anchor="end" class="lab">${esc(r.label)}</text>${segs}<text x="${(x(acc) + 8).toFixed(1)}" y="${String(y + 13)}" class="val">${esc(r.total)}</text>`;
    })
    .join('\n');
  const legend = `<div class="legend">${series.map((s, k) => `<span><i style="background:${SERIES[k] ?? ''}"></i>${esc(s)}</span>`).join('')}</div>`;
  return `${legend}<div class="scroll"><svg class="chart wide" viewBox="0 0 ${String(width)} ${String(h)}" role="img" aria-label="${esc(opts.title)}">
${grid}<line x1="${String(lw)}" y1="0" x2="${String(lw)}" y2="${String(h - 24)}" class="axis"/>
${body}
</svg></div>`;
}

/** A line over x (one series), with a hover crosshair. */
export function line(
  points: { x: number; y: number }[],
  opts: { title: string; xLabel: (x: number) => string; yLabel: (y: number) => string; color?: string },
): string {
  if (points.length < 2) return '';
  const width = 440;
  const height = 220;
  const m = { l: 52, r: 16, t: 12, b: 28 };
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y1 = Math.max(...ys) * 1.15 || 1;
  const X = (v: number) => m.l + (x1 === x0 ? 0 : ((v - x0) / (x1 - x0)) * (width - m.l - m.r));
  const Y = (v: number) => height - m.b - (v / y1) * (height - m.t - m.b);
  const grid = niceTicks(y1)
    .map(
      (t) =>
        `<line x1="${String(m.l)}" y1="${Y(t).toFixed(1)}" x2="${String(width - m.r)}" y2="${Y(t).toFixed(1)}" class="grid"/><text x="${String(m.l - 6)}" y="${(Y(t) + 4).toFixed(1)}" text-anchor="end" class="tick">${esc(opts.yLabel(t))}</text>`,
    )
    .join('');
  const xt = [x0, (x0 + x1) / 2, x1]
    .map(
      (t) =>
        `<text x="${X(t).toFixed(1)}" y="${String(height - 8)}" text-anchor="middle" class="tick">${esc(opts.xLabel(t))}</text>`,
    )
    .join('');
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(' ');
  const color = opts.color ?? SERIES[0];
  const dots = points
    .map(
      (p) =>
        `<circle cx="${X(p.x).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="${points.length <= 12 ? '4' : '2'}" fill="${color}" stroke="var(--surface)" stroke-width="1.5"/>`,
    )
    .join('');
  const data = esc(
    JSON.stringify(
      points.map((p) => [
        Number(X(p.x).toFixed(1)),
        Number(Y(p.y).toFixed(1)),
        `${opts.xLabel(p.x)}: ${opts.yLabel(p.y)}`,
      ]),
    ),
  );
  return `<svg class="chart linechart" viewBox="0 0 ${String(width)} ${String(height)}" role="img" aria-label="${esc(opts.title)}" data-points="${data}">
${grid}${xt}<line x1="${String(m.l)}" y1="${String(height - m.b)}" x2="${String(width - m.r)}" y2="${String(height - m.b)}" class="axis"/>
<path d="${path}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
${dots}
<line class="cross" x1="0" y1="${String(m.t)}" x2="0" y2="${String(height - m.b)}" visibility="hidden"/><circle class="crossdot" r="4" fill="${color}" stroke="var(--surface)" stroke-width="2" visibility="hidden"/>
<rect class="hit" x="${String(m.l)}" y="${String(m.t)}" width="${String(width - m.l - m.r)}" height="${String(height - m.t - m.b)}" fill="transparent"/>
</svg>`;
}

/** A table; `numeric` columns are right-aligned. Cells are HTML. */
export function table(head: string[], rows: string[][], numeric: number[] = []): string {
  if (rows.length === 0) return '';
  const right = new Set(numeric);
  const cls = (i: number) => (right.has(i) ? ' class="num"' : '');
  return `<div class="tablewrap"><table><thead><tr>${head.map((h, i) => `<th${cls(i)}>${h}</th>`).join('')}</tr></thead><tbody>
${rows.map((r) => `<tr>${r.map((c, i) => `<td${cls(i)}>${c}</td>`).join('')}</tr>`).join('\n')}
</tbody></table></div>`;
}

export const details = (summary: string, body: string): string =>
  body === '' ? '' : `<details><summary>${summary}</summary>${body}</details>`;

export const figure = (body: string, caption: string): string =>
  body === '' ? '' : `<figure>${body}<figcaption>${caption}</figcaption></figure>`;

export const tiles = (items: { label: string; value: string }[]): string =>
  `<div class="tiles">${items.map((t) => `<div class="tile"><div class="tlabel">${t.label}</div><div class="tvalue">${t.value}</div></div>`).join('')}</div>`;
