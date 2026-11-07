import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { MemInfo, SystemSample } from "@llama-webui/shared";

export type { MemInfo, SystemSample };

export interface CpuTimes {
  busy: number;
  total: number;
}

/** `/proc/stat` cpu lines: user nice system idle iowait irq softirq steal (guest is already in user). */
export function parseProcStat(text: string): { total: CpuTimes; cores: CpuTimes[] } | null {
  let total: CpuTimes | null = null;
  const cores: CpuTimes[] = [];
  for (const line of text.split("\n")) {
    const m = /^cpu(\d*)\s+(.*)$/.exec(line);
    if (!m) continue;
    const f = m[2]!.trim().split(/\s+/).slice(0, 8).map(Number);
    if (f.length < 4 || f.some((n) => !Number.isFinite(n))) continue;
    const sum = f.reduce((a, b) => a + b, 0);
    const idle = f[3]! + (f[4] ?? 0);
    const t = { busy: sum - idle, total: sum };
    if (m[1] === "") total = t;
    else cores[Number(m[1])] = t;
  }
  return total ? { total, cores: cores.filter(Boolean) } : null;
}

export function cpuPct(prev: CpuTimes, cur: CpuTimes): number {
  const dt = cur.total - prev.total;
  if (dt <= 0) return 0;
  return Math.min(100, Math.max(0, (100 * (cur.busy - prev.busy)) / dt));
}

export function parseMeminfo(text: string): MemInfo | null {
  const kv = new Map<string, number>();
  for (const line of text.split("\n")) {
    const m = /^(\w+):\s+(\d+)/.exec(line);
    if (m) kv.set(m[1]!, Number(m[2]) * 1024);
  }
  const total = kv.get("MemTotal");
  if (total === undefined) return null;
  const swapTotal = kv.get("SwapTotal") ?? 0;
  return {
    totalBytes: total,
    availableBytes: kv.get("MemAvailable") ?? kv.get("MemFree") ?? 0,
    cachedBytes: kv.get("Cached") ?? 0,
    swapTotalBytes: swapTotal,
    swapUsedBytes: Math.max(0, swapTotal - (kv.get("SwapFree") ?? swapTotal)),
  };
}

export function parseLoadavg(text: string): [number, number, number] | null {
  const f = text.trim().split(/\s+/).slice(0, 3).map(Number);
  return f.length === 3 && f.every(Number.isFinite) ? (f as [number, number, number]) : null;
}

const CPU_SENSORS = ["k10temp", "coretemp"];

const readText = async (p: string): Promise<string | null> => {
  try {
    return await Bun.file(p).text();
  } catch {
    return null;
  }
};

/** Machine-wide CPU, memory, load, frequency and CPU temperature. Every read failure degrades to null. */
export class SystemSampler {
  private procRoot: string;
  private sysRoot: string;
  private prev: { total: CpuTimes; cores: CpuTimes[] } | null = null;
  /** undefined = not discovered yet; null = no CPU sensor on this machine. */
  private tempPath: string | null | undefined;

  constructor(o: { procRoot?: string; sysRoot?: string } = {}) {
    this.procRoot = o.procRoot ?? "/proc";
    this.sysRoot = o.sysRoot ?? "/sys";
  }

  private async findTempPath(): Promise<string | null> {
    const dir = join(this.sysRoot, "class/hwmon");
    let entries: string[];
    try {
      entries = (await readdir(dir)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    } catch {
      return null;
    }
    for (const e of entries) {
      const name = (await readText(join(dir, e, "name")))?.trim();
      if (name && CPU_SENSORS.includes(name)) return join(dir, e, "temp1_input");
    }
    return null;
  }

  private async freqMhz(cores: number): Promise<number | null> {
    const vals = await Promise.all(
      Array.from({ length: cores }, (_, i) =>
        readText(join(this.sysRoot, "devices/system/cpu", `cpu${i}`, "cpufreq/scaling_cur_freq")),
      ),
    );
    const khz = vals.map((v) => Number(v?.trim())).filter((n) => Number.isFinite(n) && n > 0);
    return khz.length === 0 ? null : Math.round(khz.reduce((a, b) => a + b, 0) / khz.length / 1000);
  }

  async sample(): Promise<SystemSample | null> {
    if (this.tempPath === undefined) this.tempPath = await this.findTempPath();
    const [statText, memText, loadText, tempText] = await Promise.all([
      readText(join(this.procRoot, "stat")),
      readText(join(this.procRoot, "meminfo")),
      readText(join(this.procRoot, "loadavg")),
      this.tempPath ? readText(this.tempPath) : Promise.resolve(null),
    ]);
    const cur = statText === null ? null : parseProcStat(statText);
    if (!cur) return null;
    const prev = this.prev;
    this.prev = cur;
    const temp = Number(tempText?.trim());
    return {
      cpuPct: prev ? cpuPct(prev.total, cur.total) : 0,
      corePct: cur.cores.map((c, i) => (prev?.cores[i] ? cpuPct(prev.cores[i]!, c) : 0)),
      freqMhz: await this.freqMhz(cur.cores.length),
      tempC: tempText !== null && Number.isFinite(temp) ? temp / 1000 : null,
      load: loadText === null ? null : parseLoadavg(loadText),
      mem: memText === null ? null : parseMeminfo(memText),
    };
  }
}
