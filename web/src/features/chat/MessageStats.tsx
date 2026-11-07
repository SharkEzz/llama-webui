import type { MessageStats as Stats } from '@llama-webui/shared';
import { formatInt, formatPct } from '@/lib/format';

const dec = (v: number, digits = 1) =>
  new Intl.NumberFormat('fr-FR', { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(v);

/** « 1,2 s avant le 1er jeton · 183 t/s prompt · 51,2 t/s · 412 jetons · MTP 50 % ». */
export function MessageStats({ stats }: { stats: Stats }) {
  const parts = [
    stats.ttftMs !== null ? `${dec(stats.ttftMs / 1000)} s avant le 1er jeton` : null,
    `${formatInt(Math.round(stats.ppTps))} t/s prompt`,
    `${dec(stats.tgTps)} t/s`,
    `${formatInt(stats.genTokens)} jetons`,
    stats.draftN ? `MTP ${formatPct(((stats.draftAccepted ?? 0) / stats.draftN) * 100)}` : null,
  ].filter(Boolean);
  return <p className="num text-xs text-muted-foreground">{parts.join(' · ')}</p>;
}
