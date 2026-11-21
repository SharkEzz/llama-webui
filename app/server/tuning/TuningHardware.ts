import type { TuningHardware as Hardware } from '@llama-webui/shared';
import { Context, Effect, FileSystem, Layer, Path } from 'effect';
import { benchBinary } from 'llamacpp-js/node';
import { BenchHardware } from '../bench/BenchHardware.ts';
import { readText } from '../collectors/read.ts';
import { parseMeminfo } from '../collectors/system.ts';
import { expandHome } from '../config/Home.ts';
import { CpuInfo } from '../hardware/CpuInfo.ts';
import { Monitor } from '../monitor/Monitor.ts';
import { SettingsRepo } from '../settings/SettingsRepo.ts';
import { withLiveMemory } from './match.ts';

/** The machine the estimator plans on. */
export class TuningHardware extends Context.Service<
  TuningHardware,
  {
    /**
     * The devices `llama-bench --list-devices` gives for the `binary` setting (`~` expanded), with the live memory of
     * the monitor's GPUs; why the list is not trusted; the CPU (`CpuInfo`, read once); the RAM of the last snapshot, else of
     * `/proc/meminfo`, else 0.
     */
    readonly read: Effect.Effect<Hardware>;
  }
>()('@llama-webui/app/server/tuning/TuningHardware') {
  /** Reads `meminfo` under `procRoot` (`/proc`) when there is no snapshot. */
  static readonly layerWith = (
    options: { readonly procRoot?: string } = {},
  ): Layer.Layer<
    TuningHardware,
    never,
    SettingsRepo | BenchHardware | CpuInfo | Monitor | FileSystem.FileSystem | Path.Path
  > =>
    Layer.effect(
      TuningHardware,
      Effect.gen(function* () {
        const settings = yield* SettingsRepo;
        const bench = yield* BenchHardware;
        const monitor = yield* Monitor;
        const cpuInfo = yield* CpuInfo;
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* Path.Path;
        const platform = Context.make(FileSystem.FileSystem, fs).pipe(Context.add(Path.Path, paths));
        const meminfo = paths.join(options.procRoot ?? '/proc', 'meminfo');

        const read = Effect.gen(function* () {
          const { binary } = yield* settings.get;
          const expanded = yield* Effect.provideContext(expandHome(binary), platform);
          const snapshot = yield* monitor.latest;
          const live = snapshot?.system?.mem ?? null;
          const text = live === null ? yield* Effect.provideContext(readText(meminfo), platform) : null;
          const mem = live ?? parseMeminfo(text ?? '');
          const list = yield* bench.devices(benchBinary(expanded));
          const hardware: Hardware = {
            devices: withLiveMemory(list.devices, snapshot?.allGpus ?? []),
            devicesError: list.error,
            cpu: yield* cpuInfo.read,
            ramTotalBytes: mem?.totalBytes ?? 0,
            ramAvailableBytes: mem?.availableBytes ?? 0,
          };
          return hardware;
        }).pipe(Effect.withSpan('TuningHardware.read'));

        return TuningHardware.of({ read });
      }),
    );

  static readonly layer = TuningHardware.layerWith();
}
