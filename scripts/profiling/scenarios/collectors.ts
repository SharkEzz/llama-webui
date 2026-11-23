// collectors: a breakdown, not a verdict. Each NVML call the sampler makes, timed through the app's own reading code
// (`deviceHandles`, `nvmlReader`) over a library wrapped in a timing Proxy; then each /proc or sysfs file a monitor tick
// reads, re-read once per second (11 rounds, the first dropped).
//
// The reader reads some values only once their period has passed (the PCIe throughput, the power limit, the
// persistence mode) and keeps the static ones for good. Its clock is the time it is given, so the tool drives it: a
// first round that reads everything (dropped), then full samples (every period passed) and light samples (none passed)
// in turn, one per second. The table is the cost of each call in a full sample; how often a call runs comes from a
// count over one minute of samples at 1 Hz, the default interval, on a reader of its own.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { now, sleep } from '../instance.ts';
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

/** The app's own NVML code, loaded here only: `node:ffi` warns that it is experimental as it loads. */
async function loadNvml() {
  const [symbols, read] = await Promise.all([
    import('../../../app/server/collectors/nvml/symbols.ts'),
    import('../../../app/server/collectors/nvml/read.ts'),
  ]);
  return { lib: symbols.openNvml(), deviceHandles: read.deviceHandles, nvmlReader: read.nvmlReader };
}

async function nvml(skipped: string[]): Promise<Collectors['nvml']> {
  let loaded: Awaited<ReturnType<typeof loadNvml>>;
  try {
    loaded = await loadNvml();
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

/** The files of a monitor tick, by group, as the first pass's `fs-reads.ts` listed them. */
function readGroups(serverPid: number): Map<string, string[]> {
  const groups = new Map<string, string[]>([
    ['system: /proc/stat, meminfo, loadavg', ['/proc/stat', '/proc/meminfo', '/proc/loadavg']],
    ['disk: /proc/diskstats', ['/proc/diskstats']],
  ]);
  const cpus = '/sys/devices/system/cpu';
  const cores = readdirSync(cpus).filter((n) => /^cpu\d+$/.test(n));
  groups.set(
    `system: cpufreq/scaling_cur_freq × ${String(cores.length)} cores`,
    cores.map((c) => `${cpus}/${c}/cpufreq/scaling_cur_freq`),
  );
  for (const card of readdirSync('/sys/class/drm').filter((n) => /^card\d+$/.test(n))) {
    const d = `/sys/class/drm/${card}/device`;
    if (!existsSync(join(d, 'gpu_busy_percent'))) continue;
    const hwmonDir = join(d, 'hwmon');
    const hwmon = existsSync(hwmonDir) ? readdirSync(hwmonDir)[0] : undefined;
    const pci = /PCI_SLOT_NAME=(.+)/.exec(readFileSync(join(d, 'uevent'), 'utf8'))?.[1] ?? card;
    for (const f of [
      'gpu_busy_percent',
      'mem_info_vram_used',
      'mem_info_vram_total',
      'mem_busy_percent',
      'pp_dpm_sclk',
      'pp_dpm_mclk',
      'current_link_speed',
      'current_link_width',
    ])
      groups.set(`amdgpu ${pci}: ${f}`, [join(d, f)]);
    if (hwmon !== undefined)
      for (const f of ['temp1_input', 'power1_average', 'power1_input', 'pwm1', 'pwm1_max', 'power1_cap'])
        groups.set(`amdgpu ${pci}: hwmon/${f}`, [join(hwmonDir, hwmon, f)]);
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
    groups.set('llama-server: /proc/<pid>/stat, status', [`/proc/${llama}/stat`, `/proc/${llama}/status`]);
    const fds = readdirSync(`/proc/${llama}/fdinfo`);
    groups.set(
      `amdgpu: /proc/<pid>/fdinfo × ${String(fds.length)} descriptors`,
      fds.map((fd) => `/proc/${llama}/fdinfo/${fd}`),
    );
  }
  return groups;
}

async function reads(serverPid: number, skipped: string[]): Promise<Collectors['reads']> {
  const groups = readGroups(serverPid);
  for (const [label, files] of groups)
    if (!files.some((f) => existsSync(f))) {
      skipped.push(`${label}: no such file`);
      groups.delete(label);
    }
  const acc = new Map<string, { cpuMs: number; wallMs: number }>();
  for (let round = 0; round < ROUNDS; round++) {
    const r0 = now();
    for (const [label, files] of groups) {
      const c0 = process.cpuUsage();
      const t0 = now();
      for (const f of files) {
        try {
          readFileSync(f);
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

export const collectors: Scenario<'collectors'> = {
  name: 'collectors',
  run: async (ctx) => {
    const skipped: string[] = [];
    const n = await nvml(skipped);
    if (n) {
      const top = n.calls.slice(0, 5).map((c) => c.call.replace('nvmlDeviceGet', ''));
      ctx.log(
        `NVML, ${String(n.gpus)} GPUs: ${n.sampleCpuMs.toFixed(2)} ms CPU per full sample, ${(n.lightCpuMs ?? 0).toFixed(2)} ms per light one, ${(n.avgCpuMs ?? 0).toFixed(2)} ms on average at 1 Hz; costliest: ${top.join(', ')}`,
      );
    }
    const r = await reads(ctx.instance.serverPid, skipped);
    ctx.log(
      `reads: ${r.reduce((a, x) => a + x.cpuMs, 0).toFixed(2)} ms CPU per tick; costliest: ${r[0]?.label ?? '—'}`,
    );
    for (const s of skipped) ctx.log(`skipped: ${s}`);
    return { nvml: n, reads: r, skipped };
  },
};
