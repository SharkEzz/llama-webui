import type { CpuInfo as CpuInfoData } from '@llama-webui/shared';
import { Context, Effect, type FileSystem, Layer, type Path } from 'effect';
import { readCpuInfo } from './cpu.ts';

/** Machine CPU details, read once from `/proc/cpuinfo` and cached for the lifetime of the server. */
export class CpuInfo extends Context.Service<
  CpuInfo,
  {
    readonly read: Effect.Effect<CpuInfoData>;
  }
>()('@llama-webui/app/server/hardware/CpuInfo') {
  static readonly layer: Layer.Layer<CpuInfo, never, FileSystem.FileSystem | Path.Path> = Layer.effect(
    CpuInfo,
    Effect.gen(function* () {
      const platform = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
      const read = yield* Effect.cached(readCpuInfo().pipe(Effect.provideContext(platform)));
      return CpuInfo.of({ read });
    }),
  );
}
