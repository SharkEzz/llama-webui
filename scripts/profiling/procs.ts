// The CPU, memory and GPU gauge of the processes a run starts, sampled from /proc and sysfs.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { basename } from 'node:path';
import type { ProcWindow } from './results.ts';

export interface ProcSample {
  /** ms (performance.now) */
  t: number;
  /**
   * Cumulative CPU ticks of each process, by pid: a window sums the difference of each process, so one that exits
   * takes only what it spent during the window, not its lifetime, out of its group.
   */
  procs: Record<string, { group: string; utime: number; stime: number; rssKb: number }>;
  /** Cumulative CPU ticks of each thread, keyed `group/name<TAB>tid`: a window sums them by `group/name`. */
  threads: Record<string, number>;
  /** gpu_busy_percent of each amdgpu card, by PCI address */
  gpuBusy: Record<string, number>;
}

export interface ProcRoots {
  server: number | null;
  chrome: number | null;
}

interface Stat {
  comm: string;
  ppid: number;
  utime: number;
  stime: number;
  rssKb: number;
}

const PAGE_KB = 4;

function parseStat(text: string): Stat {
  // `comm` is between the first `(` and the last `)`: it may hold spaces and parentheses
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  const f = text.slice(close + 2).split(' ');
  return {
    comm: text.slice(open + 1, close),
    ppid: Number(f[1]),
    utime: Number(f[11]),
    stime: Number(f[12]),
    rssKb: Number(f[21]) * PAGE_KB,
  };
}

function readStat(path: string): Stat | null {
  try {
    return parseStat(readFileSync(path, 'utf8'));
  } catch {
    // the process or thread exited between the listing and the read
    return null;
  }
}

function cmdline(pid: number): string {
  try {
    return readFileSync(`/proc/${String(pid)}/cmdline`, 'utf8').replaceAll('\0', ' ');
  } catch {
    return '';
  }
}

/** `root` and every descendant. */
export function processTree(root: number): number[] {
  const parents = new Map<number, number>();
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const s = readStat(`/proc/${name}/stat`);
    if (s) parents.set(Number(name), s.ppid);
  }
  if (!parents.has(root)) return [];
  const out = [root];
  for (let i = 0; i < out.length; i++) for (const [pid, ppid] of parents) if (ppid === out[i]) out.push(pid);
  return out;
}

function classify(pid: number, roots: ProcRoots): string {
  if (pid === roots.server) return 'server';
  if (pid === roots.chrome) return 'chrome-browser';
  const cmd = cmdline(pid);
  if (cmd.includes('nvml-worker')) return 'nvml-worker';
  if (cmd.includes('llama-server')) return 'llama-server';
  if (cmd.includes('--type=renderer')) return 'chrome-renderer';
  if (cmd.includes('--type=gpu-process')) return 'chrome-gpu';
  if (cmd.includes('--type=')) return 'chrome-other';
  if (cmd.includes('nvidia-smi')) return 'nvidia-smi';
  return 'other';
}

/** The amdgpu cards: `gpu_busy_percent` path by PCI address. */
function amdCards(): Map<string, string> {
  const cards = new Map<string, string>();
  let names: string[] = [];
  try {
    names = readdirSync('/sys/class/drm').filter((n) => /^card\d+$/.test(n));
  } catch {
    return cards;
  }
  for (const card of names) {
    try {
      const device = `/sys/class/drm/${card}/device`;
      if (basename(readlinkSync(`${device}/driver`)) !== 'amdgpu') continue;
      cards.set(basename(readlinkSync(device)), `${device}/gpu_busy_percent`);
    } catch {
      // not a device with a driver
    }
  }
  return cards;
}

let cardCache: Map<string, string> | null = null;

export function sampleProcs(roots: ProcRoots): ProcSample {
  const procs: ProcSample['procs'] = {};
  const threads: ProcSample['threads'] = {};
  const pids = new Set<number>();
  for (const root of [roots.server, roots.chrome]) if (root !== null) for (const p of processTree(root)) pids.add(p);
  for (const pid of pids) {
    const s = readStat(`/proc/${String(pid)}/stat`);
    if (!s) continue;
    const group = classify(pid, roots);
    procs[String(pid)] = { group, utime: s.utime, stime: s.stime, rssKb: s.rssKb };
    // llama-server's threads are its compute pool: their split says nothing about the app
    if (group === 'llama-server') continue;
    let tids: string[] = [];
    try {
      tids = readdirSync(`/proc/${String(pid)}/task`);
    } catch {
      continue;
    }
    for (const tid of tids) {
      const t = readStat(`/proc/${String(pid)}/task/${tid}/stat`);
      if (!t) continue;
      // Pool threads are numbered (ThreadPoolForeg, CompositorTileW1…): one line per kind
      const name = `${group}/${t.comm.replace(/[\d#:/-]+$/, '').trim() || t.comm}`;
      threads[`${name}\t${tid}`] = t.utime + t.stime;
    }
  }
  cardCache ??= amdCards();
  const gpuBusy: Record<string, number> = {};
  for (const [address, path] of cardCache) {
    try {
      gpuBusy[address] = Number(readFileSync(path, 'utf8'));
    } catch {
      // the card went away (or does not expose the gauge)
    }
  }
  return { t: performance.now(), procs, threads, gpuBusy };
}

/**
 * The difference of a cumulative counter over the samples, per key (a process, a thread), summed by `by(key)`: the last
 * value a key reached minus its first, a key absent from the first sample counting from zero (it started during the
 * window), one gone before the last keeping what it spent until then. Never negative.
 */
function spent<T>(
  samples: ProcSample[],
  read: (s: ProcSample) => Record<string, T>,
  value: (v: T) => number,
  by: (key: string, v: T) => string,
) {
  const first = new Map<string, number>();
  const last = new Map<string, { group: string; end: number }>();
  for (const [i, s] of samples.entries())
    for (const [key, v] of Object.entries(read(s))) {
      if (i === 0) first.set(key, value(v));
      last.set(key, { group: by(key, v), end: value(v) });
    }
  const out = new Map<string, number>();
  for (const [key, { group, end }] of last)
    out.set(group, (out.get(group) ?? 0) + Math.max(0, end - (first.get(key) ?? 0)));
  return out;
}

export function cpuWindow(samples: ProcSample[], ticksPerSecond: number): ProcWindow {
  const first = samples[0];
  const final = samples.at(-1);
  const wallMs = first && final ? final.t - first.t : 0;
  const pct = (ticks: number) => (wallMs > 0 ? ((ticks / ticksPerSecond) * 1000 * 100) / wallMs : 0);
  const byGroup = (_pid: string, p: { group: string }) => p.group;
  const user = spent(
    samples,
    (s) => s.procs,
    (p) => p.utime,
    byGroup,
  );
  const sys = spent(
    samples,
    (s) => s.procs,
    (p) => p.stime,
    byGroup,
  );
  const cpuPct: Record<string, number> = {};
  const userPct: Record<string, number> = {};
  const sysPct: Record<string, number> = {};
  for (const [group, u] of user) {
    const st = sys.get(group) ?? 0;
    userPct[group] = pct(u);
    sysPct[group] = pct(st);
    cpuPct[group] = pct(u + st);
  }
  const rssMb: Record<string, number> = {};
  for (const s of samples) {
    const kb = new Map<string, number>();
    for (const p of Object.values(s.procs)) kb.set(p.group, (kb.get(p.group) ?? 0) + p.rssKb);
    for (const [group, total] of kb) rssMb[group] = total / 1024;
  }
  const threadPct: Record<string, number> = {};
  for (const [name, ticks] of spent(
    samples,
    (s) => s.threads,
    (v) => v,
    (key) => key.slice(0, key.lastIndexOf('\t')),
  )) {
    const v = pct(ticks);
    if (v >= 0.05) threadPct[name] = v;
  }
  const readings = new Map<string, number[]>();
  for (const s of samples)
    for (const [card, v] of Object.entries(s.gpuBusy)) {
      const list = readings.get(card) ?? [];
      list.push(v);
      readings.set(card, list);
    }
  const gpuBusyPct: Record<string, number> = {};
  for (const [card, list] of readings) gpuBusyPct[card] = list.reduce((a, b) => a + b, 0) / list.length;
  return { wallMs, cpuPct, userPct, sysPct, threadPct, rssMb, gpuBusyPct };
}

let clockTicks: number | null = null;

/** `getconf CLK_TCK`, read once. */
export function clockTicksPerSecond(): number {
  clockTicks ??= Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim()) || 100;
  return clockTicks;
}

/** Samples the processes once per second until `stop()`, which takes a last sample. */
export function watchProcs(roots: ProcRoots): { stop: () => ProcWindow } {
  const samples = [sampleProcs(roots)];
  const timer = setInterval(() => samples.push(sampleProcs(roots)), 1000);
  return {
    stop() {
      clearInterval(timer);
      samples.push(sampleProcs(roots));
      return cpuWindow(samples, clockTicksPerSecond());
    },
  };
}
