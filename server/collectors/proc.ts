import { join } from 'node:path';

export function parseStat(text: string): { utime: number; stime: number } | null {
  const close = text.lastIndexOf(')');
  if (close < 0) return null;
  // fields after comm start at field 3 (state); utime=14, stime=15 → indices 11, 12
  const rest = text.slice(close + 2).split(' ');
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
  return { utime, stime };
}

export function parseRss(statusText: string): number | null {
  const m = /^VmRSS:\s+(\d+)\s*kB/m.exec(statusText);
  return m ? Number(m[1]) * 1024 : null;
}

export class ProcSampler {
  private prev: { pid: number; ticks: number; at: number } | null = null;

  constructor(
    private procRoot = '/proc',
    private clkTck = 100,
    private now: () => number = Date.now,
  ) {}

  async sample(pid: number): Promise<{ cpuPct: number; rssBytes: number } | null> {
    let statText: string, statusText: string;
    try {
      [statText, statusText] = await Promise.all([
        Bun.file(join(this.procRoot, String(pid), 'stat')).text(),
        Bun.file(join(this.procRoot, String(pid), 'status')).text(),
      ]);
    } catch {
      if (this.prev?.pid === pid) this.prev = null;
      return null;
    }
    const st = parseStat(statText);
    const rss = parseRss(statusText);
    if (!st || rss === null) return null;
    const ticks = st.utime + st.stime;
    const at = this.now();
    let cpuPct = 0;
    if (this.prev && this.prev.pid === pid && at > this.prev.at) {
      cpuPct = ((ticks - this.prev.ticks) / this.clkTck / ((at - this.prev.at) / 1000)) * 100;
    }
    this.prev = { pid, ticks, at };
    return { cpuPct: Math.max(0, cpuPct), rssBytes: rss };
  }
}
