/** Parse Prometheus text exposition; key = metric name with labels verbatim. */
export function parsePrometheus(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const sp = line.lastIndexOf(' ');
    if (sp <= 0) continue;
    const value = Number(line.slice(sp + 1));
    if (!Number.isFinite(value)) continue;
    out.set(line.slice(0, sp).trim(), value);
  }
  return out;
}
