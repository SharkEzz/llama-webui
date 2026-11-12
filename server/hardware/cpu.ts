import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { CpuInfo } from '@llama-webui/shared';
import { readText } from '../proc';

export type { CpuInfo };

/** Model, physical cores (distinct physical id + core id pairs), logical threads and flags from /proc/cpuinfo. */
export function parseCpuinfo(text: string): Omit<CpuInfo, 'numaNodes'> {
  let model = '';
  let flags: string[] = [];
  const cores = new Set<string>();
  let threads = 0;
  for (const block of text.split(/\n\s*\n/)) {
    const f: Record<string, string> = {};
    for (const line of block.split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) f[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    if (f.processor === undefined) continue;
    threads++;
    model ||= f['model name'] ?? '';
    if (flags.length === 0 && f.flags) flags = f.flags.split(/\s+/).filter(Boolean);
    cores.add(`${f['physical id'] ?? '0'}:${f['core id'] ?? f.processor}`);
  }
  return { model, physicalCores: Math.max(1, cores.size), logicalThreads: Math.max(1, threads), flags };
}

/** CPU topology; NUMA nodes counted from /sys/devices/system/node/node*, 1 when unreadable. */
export async function readCpuInfo(procRoot = '/proc', sysRoot = '/sys'): Promise<CpuInfo> {
  let text = '';
  try {
    text = await readText(join(procRoot, 'cpuinfo'));
  } catch {}
  let numaNodes = 1;
  try {
    const nodes = (await readdir(join(sysRoot, 'devices', 'system', 'node'))).filter((n) => /^node\d+$/.test(n));
    if (nodes.length > 0) numaNodes = nodes.length;
  } catch {}
  return { ...parseCpuinfo(text), numaNodes };
}
