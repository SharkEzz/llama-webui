import { readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { DiskSample } from '@llama-webui/shared';

export type { DiskSample };

const SECTOR = 512;

/** `/proc/diskstats`: field 6 = sectors read, field 10 = sectors written (always 512-byte units). */
export function parseDiskstats(text: string): Map<string, { readBytes: number; writeBytes: number }> {
  const out = new Map<string, { readBytes: number; writeBytes: number }>();
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    const r = Number(f[5]);
    const w = Number(f[9]);
    if (!Number.isFinite(r) || !Number.isFinite(w)) continue;
    out.set(f[2]!, { readBytes: r * SECTOR, writeBytes: w * SECTOR });
  }
  return out;
}

const VIRTUAL = /^(loop|ram|zram)\d/;

/** Whole physical disks: /sys/block entries backed by a device, minus loop/ram/zram. */
export async function physicalDisks(sysBlockRoot = '/sys/block'): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(sysBlockRoot);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (VIRTUAL.test(e)) continue;
    try {
      await stat(join(sysBlockRoot, e, 'device'));
      out.push(e);
    } catch {}
  }
  return out.sort();
}

/** glibc gnu_dev_major / gnu_dev_minor. */
export function devMajorMinor(dev: bigint): [number, number] {
  const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & ~0xfffn);
  const minor = (dev & 0xffn) | ((dev >> 12n) & ~0xffn);
  return [Number(major), Number(minor)];
}

const defaultStatDev = async (p: string): Promise<bigint> => (await stat(p, { bigint: true })).dev;

/** Disk holding `path` (a partition resolves to its parent disk); null when unknown (tmpfs, btrfs, NFS, missing file). */
export async function resolveModelDisk(
  path: string,
  o: { sysRoot?: string; statDev?: (p: string) => Promise<bigint> } = {},
): Promise<string | null> {
  try {
    const [major, minor] = devMajorMinor(await (o.statDev ?? defaultStatDev)(path));
    if (major === 0) return null;
    const real = await realpath(join(o.sysRoot ?? '/sys', 'dev/block', `${major}:${minor}`));
    try {
      await stat(join(real, 'partition'));
      return basename(dirname(real));
    } catch {
      return basename(real);
    }
  } catch {
    return null;
  }
}

type Counters = Map<string, { readBytes: number; writeBytes: number }>;

export class DiskSampler {
  private disks: string[];
  private procRoot: string;
  private now: () => number;
  private prev: { at: number; counters: Counters } | null = null;

  constructor(o: { disks: string[]; procRoot?: string; now?: () => number }) {
    this.disks = o.disks;
    this.procRoot = o.procRoot ?? '/proc';
    this.now = o.now ?? Date.now;
  }

  async sample(modelDisk: string | null): Promise<DiskSample | null> {
    let text: string;
    try {
      text = await Bun.file(join(this.procRoot, 'diskstats')).text();
    } catch {
      return null;
    }
    const counters = parseDiskstats(text);
    const at = this.now();
    const prev = this.prev;
    this.prev = { at, counters };
    const dt = prev ? (at - prev.at) / 1000 : 0;
    const rate = (disk: string, field: 'readBytes' | 'writeBytes'): number => {
      const c = counters.get(disk)?.[field];
      const p = prev?.counters.get(disk)?.[field];
      if (c === undefined || p === undefined || dt <= 0) return 0;
      return Math.max(0, (c - p) / dt);
    };
    let readBps = 0;
    let writeBps = 0;
    const perDisk: DiskSample['perDisk'] = {};
    for (const d of this.disks) {
      const r = { readBps: rate(d, 'readBytes'), writeBps: rate(d, 'writeBytes') };
      perDisk[d] = r;
      readBps += r.readBps;
      writeBps += r.writeBps;
    }
    const model =
      modelDisk && counters.has(modelDisk) ? { disk: modelDisk, readBps: rate(modelDisk, 'readBytes') } : null;
    return { readBps, writeBps, perDisk, model };
  }
}
