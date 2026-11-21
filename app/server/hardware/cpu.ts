import type { CpuInfo } from '@llama-webui/shared';
import { Array as Arr, Effect, FileSystem, HashSet, Option, Path, String as Str } from 'effect';

/** Model, physical cores (distinct physical id + core id pairs), logical threads and flags from /proc/cpuinfo. */
export function parseCpuinfo(text: string): Omit<CpuInfo, 'numaNodes'> {
  let model = '';
  let flags: ReadonlyArray<string> = [];
  let cores = HashSet.empty<string>();
  let threads = 0;
  for (const block of Str.split(text, /\n\s*\n/)) {
    const fields: Record<string, string> = {};
    for (const line of Str.split(block, '\n')) {
      const colon = Str.indexOf(':')(line);
      if (Option.isSome(colon) && colon.value > 0) {
        fields[Str.trim(Str.slice(0, colon.value)(line))] = Str.trim(Str.slice(colon.value + 1)(line));
      }
    }
    const processor = fields.processor;
    if (processor === undefined) continue;
    threads++;
    if (model === '') model = fields['model name'] ?? '';
    if (Arr.isReadonlyArrayEmpty(flags) && fields.flags !== undefined) {
      flags = Arr.filter(Str.split(fields.flags, /\s+/), (flag) => flag !== '');
    }
    cores = HashSet.add(cores, `${fields['physical id'] ?? '0'}:${fields['core id'] ?? processor}`);
  }
  return { model, physicalCores: Math.max(1, HashSet.size(cores)), logicalThreads: Math.max(1, threads), flags };
}

/** CPU topology; NUMA nodes counted from /sys/devices/system/node/node*, 1 when unreadable. */
export const readCpuInfo = Effect.fn('cpu.readCpuInfo')(function* (
  options: { readonly procRoot?: string; readonly sysRoot?: string } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fs
    .readFileString(path.join(options.procRoot ?? '/proc', 'cpuinfo'))
    .pipe(Effect.orElseSucceed(() => ''));
  const nodes = yield* fs
    .readDirectory(path.join(options.sysRoot ?? '/sys', 'devices', 'system', 'node'))
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  const numaNodes = Math.max(1, Arr.filter(nodes, (entry) => /^node\d+$/.test(entry)).length);
  return { ...parseCpuinfo(text), numaNodes } satisfies CpuInfo;
});
