import type { MessageStats as Stats } from '@llama-webui/shared';
import { formatInt, formatPct, num, plural } from '@/lib/format';

const dec = (v: number, digits = 1) => num(digits).format(v);

/** “1.2 s to first token · 183 t/s prompt · 51.2 t/s · 412 tokens · MTP 50%”. */
export function MessageStats({ stats }: { stats: Stats }) {
  const parts = [
    stats.ttftMs !== null ? `${dec(stats.ttftMs / 1000)} s to first token` : null,
    `${formatInt(Math.round(stats.ppTps))} t/s prompt`,
    `${dec(stats.tgTps)} t/s`,
    `${formatInt(stats.genTokens)} ${plural(stats.genTokens, 'token')}`,
    stats.draftN ? `MTP ${formatPct(((stats.draftAccepted ?? 0) / stats.draftN) * 100)}` : null,
  ].filter(Boolean);
  return <p className="num text-xs text-muted-foreground">{parts.join(' · ')}</p>;
}
