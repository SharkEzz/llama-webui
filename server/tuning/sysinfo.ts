import { readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { resolveModelDisk } from '../collectors/disk';
import { readText, spawnProc, which } from '../proc';

export interface SysReadings {
  /** scaling_governor of every core; empty when unreadable. */
  governors: string[];
  /** The bracketed value of transparent_hugepage/enabled; null when unreadable. */
  thp: string | null;
  /** Soft "Max locked memory" of this process; Infinity = unlimited; null when unreadable. */
  memlockLimitBytes: number | null;
  swappiness: number | null;
  cmdline: string;
  /** /sys/class/iommu has entries; null when the directory is unreadable. */
  iommuActive: boolean | null;
  modules: string[];
  /** Basenames of libggml-*.so next to the resolved binary. */
  backendLibs: string[];
  driver: string | null;
  /** 12080 = 12.8 */
  cudaDriver: number | null;
  /** Largest BAR of each asked PCI device (the VRAM aperture), by bus id. */
  bar1Bytes: Record<string, number>;
  /** power_dpm_force_performance_level of each AMD card, by bus id, with the file to write. */
  amdDpm: Record<string, { level: string; path: string }>;
  /** ms of the last commit of the git checkout holding the binary; null when there is none. */
  buildDate: number | null;
  /** Last "system_info:" log line. */
  systemInfo: string | null;
  /** The logs say the driver is too old for the CUDA runtime of the build. */
  cudaDriverError: boolean;
  modelDisk: { rotational: boolean | null; fsType: string | null } | null;
}

export interface SysDeps {
  procRoot?: string;
  sysRoot?: string;
  binary: string;
  modelPath: string | null;
  logLines: () => readonly { text: string }[];
  nvml?: { driver: string | null; cudaDriver: number | null } | null;
  /** PCI bus ids of the GPUs to look at (BAR1, DPM). */
  busIds?: string[];
  resolveDisk?: (path: string) => Promise<string | null>;
}

async function text(path: string): Promise<string | null> {
  try {
    return (await readText(path)).trim();
  } catch {
    return null;
  }
}

async function listDir(path: string): Promise<string[] | null> {
  try {
    return await readdir(path);
  } catch {
    return null;
  }
}

/** Absolute, symlink-free path of a binary (bare name looked up in the PATH); null when not found. */
export async function resolveBinary(binary: string): Promise<string | null> {
  const p = binary.includes('/') ? binary : which(binary);
  if (!p) return null;
  try {
    return await realpath(isAbsolute(p) ? p : join(process.cwd(), p));
  } catch {
    return null;
  }
}

async function gitRoot(dir: string): Promise<string | null> {
  let d = dir;
  for (let i = 0; i < 4; i++) {
    try {
      await stat(join(d, '.git'));
      return d;
    } catch {}
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}

async function lastCommitMs(repo: string): Promise<number | null> {
  try {
    const proc = spawnProc(['git', '-C', repo, 'log', '-1', '--format=%ct'], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    const n = Number(out);
    return Number.isFinite(n) && n > 0 ? n * 1000 : null;
  } catch {
    return null;
  }
}

async function largestBar(resource: string | null): Promise<number> {
  if (!resource) return 0;
  let max = 0;
  for (const line of resource.split('\n').slice(0, 6)) {
    const [start, end] = line.trim().split(/\s+/);
    if (!start || !end) continue;
    try {
      const size = Number(BigInt(end) - BigInt(start) + 1n);
      if (size > max) max = size;
    } catch {}
  }
  return max;
}

async function fsTypeOf(mounts: string | null, path: string): Promise<string | null> {
  if (!mounts) return null;
  let best: { point: string; type: string } | null = null;
  for (const line of mounts.split('\n')) {
    const [, point, type] = line.split(/\s+/);
    if (!point || !type) continue;
    const covers = point === '/' || path === point || path.startsWith(`${point}/`);
    if (covers && (!best || point.length > best.point.length)) best = { point, type };
  }
  return best?.type ?? null;
}

/** Every reading the system checks need; each one tolerant (null / empty when unreadable), never a rejection. */
export async function readSys(d: SysDeps): Promise<SysReadings> {
  const proc = d.procRoot ?? '/proc';
  const sys = d.sysRoot ?? '/sys';

  const governors: string[] = [];
  const cpus = ((await listDir(join(sys, 'devices/system/cpu'))) ?? [])
    .filter((n) => /^cpu\d+$/.test(n))
    .sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)));
  for (const c of cpus) {
    const g = await text(join(sys, 'devices/system/cpu', c, 'cpufreq/scaling_governor'));
    if (g !== null) governors.push(g);
  }
  const thpRaw = await text(join(sys, 'kernel/mm/transparent_hugepage/enabled'));
  const thp = thpRaw ? (/\[(\w+)\]/.exec(thpRaw)?.[1] ?? thpRaw) : null;
  const limits = await text(join(proc, 'self/limits'));
  const memlockRaw = limits ? /^Max locked memory\s+(\S+)/m.exec(limits)?.[1] : undefined;
  const memlockLimitBytes =
    memlockRaw === undefined ? null : memlockRaw === 'unlimited' ? Number.POSITIVE_INFINITY : Number(memlockRaw);
  const swapRaw = await text(join(proc, 'sys/vm/swappiness'));
  const swappiness = swapRaw === null || Number.isNaN(Number(swapRaw)) ? null : Number(swapRaw);
  const cmdline = (await text(join(proc, 'cmdline'))) ?? '';
  const iommuEntries = await listDir(join(sys, 'class/iommu'));
  const iommuActive = iommuEntries === null ? null : iommuEntries.length > 0;
  const modules = ((await text(join(proc, 'modules'))) ?? '')
    .split('\n')
    .map((l) => l.split(/\s+/)[0] ?? '')
    .filter(Boolean);

  const binary = await resolveBinary(d.binary);
  const backendLibs = binary
    ? ((await listDir(dirname(binary))) ?? []).filter((n) => /^libggml-.*\.so/.test(n)).sort()
    : [];
  const repo = binary ? await gitRoot(dirname(binary)) : null;
  const buildDate = repo ? await lastCommitMs(repo) : null;

  const driver = d.nvml?.driver ?? (await text(join(sys, 'module/nvidia/version')));
  const cudaDriver = d.nvml?.cudaDriver ?? null;

  const busIds = d.busIds ?? [];
  const bar1Bytes: Record<string, number> = {};
  for (const bus of busIds) {
    const size = await largestBar(await text(join(sys, 'bus/pci/devices', bus, 'resource')));
    if (size > 0) bar1Bytes[bus] = size;
  }
  const amdDpm: Record<string, { level: string; path: string }> = {};
  for (const card of ((await listDir(join(sys, 'class/drm'))) ?? []).filter((n) => /^card\d+$/.test(n))) {
    const file = join(sys, 'class/drm', card, 'device/power_dpm_force_performance_level');
    let bus: string;
    try {
      bus = basename(await realpath(join(sys, 'class/drm', card, 'device')));
    } catch {
      continue;
    }
    if (d.busIds && !busIds.includes(bus)) continue;
    const level = await text(file);
    if (level !== null) amdDpm[bus] = { level, path: file };
  }

  const lines = d.logLines();
  let systemInfo: string | null = null;
  let cudaDriverError = false;
  for (const l of lines) {
    if (l.text.includes('system_info:')) systemInfo = l.text;
    if (/driver version is insufficient/i.test(l.text)) cudaDriverError = true;
  }

  let modelDisk: SysReadings['modelDisk'] = null;
  if (d.modelPath) {
    const disk = await (d.resolveDisk ?? ((p: string) => resolveModelDisk(p, { sysRoot: sys })))(d.modelPath);
    const rot = disk ? await text(join(sys, 'block', disk, 'queue/rotational')) : null;
    modelDisk = {
      rotational: rot === null ? null : rot === '1',
      fsType: await fsTypeOf(await text(join(proc, 'mounts')), d.modelPath),
    };
  }

  return {
    governors,
    thp,
    memlockLimitBytes,
    swappiness,
    cmdline,
    iommuActive,
    modules,
    backendLibs,
    driver,
    cudaDriver,
    bar1Bytes,
    amdDpm,
    buildDate,
    systemInfo,
    cudaDriverError,
    modelDisk,
  };
}
