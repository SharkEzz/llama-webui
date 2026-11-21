import type { CpuInfo as CpuInfoData } from '@llama-webui/shared';
import { Context, Effect, type FileSystem, Layer, type Path } from 'effect';
import { readCpuInfo } from './cpu.ts';

/**
 * Machine CPU details, read once from `/proc/cpuinfo` and `/sys` and cached for the lifetime of the server: the one CPU
 * read of the system info, the tuning hardware and the bench's hardware.
 */
export class CpuInfo extends Context.Service<
  CpuInfo,
  {
    readonly read: Effect.Effect<CpuInfoData>;
  }
>()('@llama-webui/app/server/hardware/CpuInfo') {
  /** Reads `cpuinfo` under `procRoot` (`/proc`) and the NUMA nodes under `sysRoot` (`/sys`). */
  static readonly layerWith = (
    options: { readonly procRoot?: string; readonly sysRoot?: string } = {},
  ): Layer.Layer<CpuInfo, never, FileSystem.FileSystem | Path.Path> =>
    Layer.effect(
      CpuInfo,
      Effect.gen(function* () {
        const platform = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
        const read = yield* Effect.cached(readCpuInfo(options).pipe(Effect.provideContext(platform)));
        return CpuInfo.of({ read });
      }),
    );

  static readonly layer = CpuInfo.layerWith();
}
