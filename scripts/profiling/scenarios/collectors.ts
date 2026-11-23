// collectors: a breakdown, not a verdict. Each NVML call the sampler makes, timed through the app's own reading code
// (`deviceHandles`, `nvmlReader`) over a library wrapped in a timing Proxy; then each /proc or sysfs file a monitor tick
// reads again each time (the cards the instance hides left out), re-read once per second (11 rounds, the first
// dropped).
//
// The reader reads some values only once their period has passed (the PCIe throughput, the power limit, the
// persistence mode) and keeps the static ones for good. Its clock is the time it is given, so the tool drives it: a
// first round that reads everything (dropped), then full samples (every period passed) and light samples (none passed)
// in turn, one per second. The table is the cost of each call in a full sample; how often a call runs comes from a
// count over one minute of samples at 1 Hz, the default interval, on a reader of its own.
import { existsSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type * as NvmlRead from '../../../app/server/collectors/nvml/read.ts';
import type * as NvmlSymbols from '../../../app/server/collectors/nvml/symbols.ts';
import { now, sleep } from '../instance.ts';
import { isRecord } from '../json.ts';
import type { Scenario } from '../measure.ts';
import type { ScenarioResults } from '../results.ts';

const ROUNDS = 11;
/** Full and light NVML samples, each, after the dropped first round. */
const NVML_ROUNDS = 10;
/** A step of the reader's clock past every period: each slow value is due. */
const PAST_EVERY_PERIOD_MS = 3_600_000;
/** The samples of the count of how often each call runs: one minute at 1 Hz. */
const MINUTE_SAMPLES = 60;
/** The calls that take a type or counter argument after the handle, named by it as the first pass did. */
const ARG_NAMES: Record<string, Record<number, string>> = {
  nvmlDeviceGetClockInfo: { 0: 'graphics', 2: 'mem' },
  nvmlDeviceGetMaxClockInfo: { 0: 'graphics', 2: 'mem' },
  nvmlDeviceGetPcieThroughput: { 0: 'tx', 1: 'rx' },
};
const cpuMs = (c: NodeJS.CpuUsage) => (c.user + c.system) / 1000;

type Collectors = ScenarioResults['collectors'];

const exportsFunctions = (module: unknown, names: string[]): boolean =>
  isRecord(module) && names.every((name) => typeof module[name] === 'function');
const isSymbols = (module: unknown): module is typeof NvmlSymbols => exportsFunctions(module, ['openNvml']);
const isRead = (module: unknown): module is typeof NvmlRead =>
  exportsFunctions(module, ['deviceHandles', 'nvmlReader']);

/**
 * The app's own NVML code, from the sources of the side under measure (`root`), loaded here only: `node:ffi` warns
 * that it is experimental as it loads. A base whose reader does not export what this scenario calls is refused: its
 * NVML table is then skipped, and the head's is shown without comparison.
 */
async function loadNvml(root: string) {
  const load = async (file: string): Promise<unknown> => {
    const module: unknown = await import(pathToFileURL(join(root, 'app/server/collectors/nvml', file)).href);
    return module;
  };
  const [symbols, read] = await Promise.all([load('symbols.ts'), load('read.ts')]);
  if (!isSymbols(symbols) || !isRead(read))
    throw new Error(`${root} does not export openNvml, deviceHandles and nvmlReader as this tool calls them`);
  return { lib: symbols.openNvml(), deviceHandles: read.deviceHandles, nvmlReader: read.nvmlReader };
}

async function nvml(root: string, skipped: string[]): Promise<Collectors['nvml']> {
  let loaded: Awaited<ReturnType<typeof loadNvml>>;
  try {
    loaded = await loadNvml(root);
  } catch (error) {
    skipped.push(`NVML: the library does not load (${error instanceof Error ? error.message : String(error)})`);
    return null;
  }
  const { lib, deviceHandles, nvmlReader } = loaded;
  if (lib.nvmlInit_v2() !== 0) {
    skipped.push('NVML: nvmlInit_v2 failed');
    return null;
  }
  const calls = new Map<string, { cpuMs: number; wallMs: number }>();
  const counts = new Map<string, number>();
  const timing = { on: false, counting: false };
  const timed = new Proxy(lib, {
    get(target, prop, receiver): unknown {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function' || typeof prop !== 'string') return value;
      return (...args: unknown[]): unknown => {
        const c0 = process.cpuUsage();
        const t0 = now();
        const result: unknown = Reflect.apply(value, target, args);
        if (timing.on || timing.counting) {
          const arg = args[1];
          const named = typeof arg === 'number' ? ARG_NAMES[prop]?.[arg] : undefined;
          const call = named === undefined ? prop : `${prop}(${named})`;
          if (timing.counting) {
            counts.set(call, (counts.get(call) ?? 0) + 1);
            return result;
          }
          const a = calls.get(call) ?? { cpuMs: 0, wallMs: 0 };
          a.cpuMs += cpuMs(process.cpuUsage(c0));
          a.wallMs += now() - t0;
          calls.set(call, a);
        }
        return result;
      };
    },
  });
  try {
    const handles = deviceHandles(timed);
    const read = nvmlReader(timed, handles);
    const full = { cpuMs: 0, wallMs: 0 };
    const light = { cpuMs: 0, wallMs: 0 };
    let clock = 0;
    for (let round = 0; round <= 2 * NVML_ROUNDS; round++) {
      // Round 0 reads everything and is dropped; then odd rounds are full samples, even rounds light ones.
      const isFull = round % 2 === 1;
      if (isFull) clock += PAST_EVERY_PERIOD_MS;
      const r0 = now();
      const c0 = process.cpuUsage();
      timing.on = isFull;
      read({ skipGpus: [] }, clock);
      if (round > 0) {
        const into = isFull ? full : light;
        into.cpuMs += cpuMs(process.cpuUsage(c0));
        into.wallMs += now() - r0;
      }
      await sleep(Math.max(0, 1000 - (now() - r0)));
    }
    timing.on = false;
    timing.counting = true;
    const counted = nvmlReader(timed, handles);
    for (let i = 0; i < MINUTE_SAMPLES; i++) counted({ skipGpus: [] }, i * 1000);
    timing.counting = false;
    const n = NVML_ROUNDS;
    // Per full sample, summed over the cards; how many of the minute's samples make each call (on one card: the count
    // is over every card).
    const perCall = [...calls]
      .map(([call, a]) => ({
        call,
        cpuMs: a.cpuMs / n,
        wallMs: a.wallMs / n,
        runsPerMinute: (counts.get(call) ?? 0) / Math.max(1, handles.length),
      }))
      .toSorted((x, y) => y.cpuMs - x.cpuMs);
    const lightCpuMs = light.cpuMs / n;
    return {
      gpus: handles.length,
      sampleCpuMs: full.cpuMs / n,
      sampleWallMs: full.wallMs / n,
      lightCpuMs,
      lightWallMs: light.wallMs / n,
      // A light sample, plus the calls it leaves out as often as they run at 1 Hz.
      avgCpuMs:
        lightCpuMs +
        perCall
          .filter((c) => c.runsPerMinute < MINUTE_SAMPLES)
          .reduce((sum, c) => sum + (c.cpuMs * c.runsPerMinute) / MINUTE_SAMPLES, 0),
      calls: perCall,
    };
  } finally {
    lib.nvmlShutdown();
  }
}

/** How a file of a tick is read: its content, or the target of a link (`/proc/<pid>/fd/N`). */
type Read = 'file' | 'link';

/** The CPU sensor's `temp1_input`, as the system sampler finds it: the first hwmon named `k10temp` or `coretemp`. */
function cpuTemp(): string | undefined {
  const dir = '/sys/class/hwmon';
  const entries = existsSync(dir)
    ? readdirSync(dir).toSorted((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    : [];
  const found = entries.find((e) => {
    try {
      return ['k10temp', 'coretemp'].includes(readFileSync(join(dir, e, 'name'), 'utf8').trim());
    } catch {
      return false;
    }
  });
  return found === undefined ? undefined : join(dir, found, 'temp1_input');
}

/** The PCI address of a DRM entry (`card1`, `renderD128`), from its `device` link. */
const pciOf = (entry: string): string | undefined => {
  try {
    return basename(realpathSync(`/sys/class/drm/${entry}/device`));
  } catch {
    return undefined;
  }
};

/**
 * The files of a monitor tick, by group, written from `app/server/collectors/`: what a tick reads again each time.
 * A hidden card (`hiddenGpus`) is not read, nor the fdinfo of a descriptor open on it; what the app keeps (an AMD
 * card's link maximum, the CPU sensor's path) is not in the list.
 */
function readGroups(
  serverPid: number,
  hiddenGpus: ReadonlyArray<string>,
): Map<string, { read: Read; files: string[] }> {
  const groups = new Map<string, { read: Read; files: string[] }>([
    ['system: /proc/stat, meminfo, loadavg', { read: 'file', files: ['/proc/stat', '/proc/meminfo', '/proc/loadavg'] }],
    ['disk: /proc/diskstats', { read: 'file', files: ['/proc/diskstats'] }],
  ]);
  const temp = cpuTemp();
  if (temp !== undefined) groups.set('system: hwmon CPU temp1_input', { read: 'file', files: [temp] });
  const cpus = '/sys/devices/system/cpu';
  const cores = readdirSync(cpus).filter((n) => /^cpu\d+$/.test(n));
  groups.set(`system: cpufreq/scaling_cur_freq × ${String(cores.length)} cores`, {
    read: 'file',
    files: cores.map((c) => `${cpus}/${c}/cpufreq/scaling_cur_freq`),
  });
  const drm = readdirSync('/sys/class/drm');
  const hiddenNodes = new Set(drm.filter((n) => /^(card|renderD)\d+$/.test(n) && hiddenGpus.includes(pciOf(n) ?? '')));
  let amdRead = false;
  for (const card of drm.filter((n) => /^card\d+$/.test(n))) {
    const d = `/sys/class/drm/${card}/device`;
    if (!existsSync(join(d, 'gpu_busy_percent'))) continue;
    const pci = pciOf(card) ?? card;
    if (hiddenGpus.includes(pci)) continue;
    amdRead = true;
    const hwmonDir = join(d, 'hwmon');
    const hwmon = existsSync(hwmonDir) ? readdirSync(hwmonDir)[0] : undefined;
    for (const f of [
      'power/runtime_status',
      'gpu_busy_percent',
      'mem_info_vram_used',
      'mem_info_vram_total',
      'mem_busy_percent',
      'pp_dpm_sclk',
      'pp_dpm_mclk',
      'current_link_speed',
      'current_link_width',
    ])
      groups.set(`amdgpu ${pci}: ${f}`, { read: 'file', files: [join(d, f)] });
    if (hwmon !== undefined)
      for (const f of ['temp1_input', 'power1_average', 'power1_input', 'pwm1', 'pwm1_max', 'power1_cap'])
        groups.set(`amdgpu ${pci}: hwmon/${f}`, { read: 'file', files: [join(hwmonDir, hwmon, f)] });
  }
  const llama = readdirSync('/proc')
    .filter((n) => /^\d+$/.test(n))
    .find((pid) => {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        return (
          stat.includes('(llama-server)') && stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1] === String(serverPid)
        );
      } catch {
        return false;
      }
    });
  if (llama !== undefined) {
    groups.set('llama-server: /proc/<pid>/stat, status', {
      read: 'file',
      files: [`/proc/${llama}/stat`, `/proc/${llama}/status`],
    });
    if (amdRead) {
      // Every descriptor's link, then the fdinfo of those open on a DRM node of a card that is read.
      const fds = readdirSync(`/proc/${llama}/fd`);
      const onCard = fds.filter((fd) => {
        try {
          const node = basename(readlinkSync(`/proc/${llama}/fd/${fd}`));
          return /^(card|renderD)\d+$/.test(node) && !hiddenNodes.has(node);
        } catch {
          return false;
        }
      });
      groups.set(`amdgpu: /proc/<pid>/fd links × ${String(fds.length)} descriptors`, {
        read: 'link',
        files: fds.map((fd) => `/proc/${llama}/fd/${fd}`),
      });
      groups.set(`amdgpu: /proc/<pid>/fdinfo × ${String(onCard.length)} DRM descriptors`, {
        read: 'file',
        files: onCard.map((fd) => `/proc/${llama}/fdinfo/${fd}`),
      });
    }
  }
  return groups;
}

async function reads(
  serverPid: number,
  hiddenGpus: ReadonlyArray<string>,
  skipped: string[],
): Promise<Collectors['reads']> {
  const groups = readGroups(serverPid, hiddenGpus);
  for (const [label, { files }] of groups)
    if (!files.some((f) => existsSync(f))) {
      skipped.push(`${label}: no such file`);
      groups.delete(label);
    }
  const acc = new Map<string, { cpuMs: number; wallMs: number }>();
  for (let round = 0; round < ROUNDS; round++) {
    const r0 = now();
    for (const [label, { read, files }] of groups) {
      const c0 = process.cpuUsage();
      const t0 = now();
      for (const f of files) {
        try {
          if (read === 'link') readlinkSync(f);
          else readFileSync(f);
        } catch {
          // a file gone between two rounds (an fd closed) costs its failed open, as in the monitor
        }
      }
      if (round === 0) continue;
      const a = acc.get(label) ?? { cpuMs: 0, wallMs: 0 };
      a.cpuMs += cpuMs(process.cpuUsage(c0));
      a.wallMs += now() - t0;
      acc.set(label, a);
    }
    await sleep(Math.max(0, 1000 - (now() - r0)));
  }
  const n = ROUNDS - 1;
  return [...acc]
    .map(([label, a]) => ({ label, cpuMs: a.cpuMs / n, wallMs: a.wallMs / n }))
    .toSorted((x, y) => y.cpuMs - x.cpuMs);
}

/** The cards the instance does not read (`hiddenGpus` of its settings). */
async function hiddenGpusOf(api: (path: string) => Promise<unknown>): Promise<string[]> {
  const settings = await api('/api/settings');
  const hidden = isRecord(settings) ? settings.hiddenGpus : undefined;
  return Array.isArray(hidden) ? hidden.filter((g): g is string => typeof g === 'string') : [];
}

export const collectors: Scenario<'collectors'> = {
  name: 'collectors',
  run: async (ctx) => {
    const skipped: string[] = [];
    const n = await nvml(ctx.target.root, skipped);
    if (n) {
      const top = n.calls.slice(0, 5).map((c) => c.call.replace('nvmlDeviceGet', ''));
      ctx.log(
        `NVML, ${String(n.gpus)} GPUs: ${n.sampleCpuMs.toFixed(2)} ms CPU per full sample, ${(n.lightCpuMs ?? 0).toFixed(2)} ms per light one, ${(n.avgCpuMs ?? 0).toFixed(2)} ms on average at 1 Hz; costliest: ${top.join(', ')}`,
      );
    }
    const r = await reads(ctx.instance.serverPid, await hiddenGpusOf(ctx.instance.api), skipped);
    ctx.log(
      `reads: ${r.reduce((a, x) => a + x.cpuMs, 0).toFixed(2)} ms CPU per tick; costliest: ${r[0]?.label ?? '—'}`,
    );
    for (const s of skipped) ctx.log(`skipped: ${s}`);
    return { nvml: n, reads: r, skipped };
  },
};
