import type { Section } from '../cell.ts';
import { details, table } from '../charts.ts';
import { code, ms } from '../format.ts';
import { section, windowsBlock } from './common.ts';

export const pages: Section = (results, cell) => {
  const s = results.scenarios.pages;
  if (!s) return null;
  const rows = s.pages.map((p) => [
    code(p.path),
    cell(`pages.${p.path}.ttfbMs`),
    cell(`pages.${p.path}.fcpMs`),
    cell(`pages.${p.path}.lcpMs`),
    cell(`pages.${p.path}.requests`),
    cell(`pages.${p.path}.wireBytes`),
    cell(`pages.${p.window.id}.cpu.chrome-renderer`),
  ]);
  const calls = s.pages.flatMap((p) => p.apiCalls.map((c) => [code(p.path), code(c.url), ms(c.ms)]));
  return section(
    'pages',
    'Every page',
    'Each page loaded cold in a new browser context, then watched 12 s.',
    `${table(['Page', 'TTFB', 'FCP', 'LCP', 'Requests', 'Bytes on the wire', 'Renderer CPU'], rows, [1, 2, 3, 4, 5, 6])}
${details('API calls made by each page', table(['Page', 'URL', 'Duration'], calls, [2]))}
${details(
  'Every window',
  windowsBlock(
    'pages',
    s.pages.map((p) => p.window),
    cell,
  ),
)}`,
  );
};
