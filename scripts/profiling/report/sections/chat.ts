import type { Section } from '../cell.ts';
import { table, tiles } from '../charts.ts';
import { esc, num } from '../format.ts';
import { section, windowsBlock } from './common.ts';

export const chat: Section = (results, cell) => {
  const s = results.scenarios.chat;
  if (!s) return null;
  const spans = s.windows.map((w) => {
    const span = s.spans[w.id];
    return [esc(w.label), span ? num(span.fromChars) : '—', span ? num(span.toChars) : '—'];
  });
  return section(
    'chat',
    'Chat page streaming a reply',
    'The Chat page while a long Markdown reply streams in a temporary conversation: three successive windows over the same reply.',
    `${tiles([
      { label: 'reply length', value: `${num(s.reply.chars)} characters` },
      { label: 'reply tokens', value: num(s.reply.tokens) },
      { label: 'tokens per second', value: cell('chat.reply.tokensPerSec') },
    ])}
${table(['Window', 'From character', 'To character'], spans, [1, 2])}
${windowsBlock('chat', s.windows, cell)}`,
  );
};
