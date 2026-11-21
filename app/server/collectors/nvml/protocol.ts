/*
 * What the server and the NVML sampler (`worker.ts`) say to each other, one JSON value per line: commands on the
 * sampler's stdin, messages on its stdout. Both sides decode them with these schemas.
 */
import { GpuReading } from '@llama-webui/shared';
import { Schema } from 'effect';

/** What the sampler reads (`GpuNeeds` of `../gpu.ts`). */
export const Needs = Schema.Struct({
  pcie: Schema.Boolean,
  skipGpus: Schema.Array(Schema.String),
});

/** The driver's versions. */
export const NvmlSystem = Schema.Struct({
  /** "580.95.05"; null when NVML cannot tell. */
  driver: Schema.NullOr(Schema.String),
  /** 13000 = CUDA 13.0, the newest runtime the driver supports; null when unknown. */
  cudaDriver: Schema.NullOr(Schema.Int),
});
export type NvmlSystem = typeof NvmlSystem.Type;

/** A process on a card. */
export const NvmlProc = Schema.Struct({
  pid: Schema.Int,
  /** The card's key (`nvidia:<uuid>`). */
  key: Schema.String,
  /** null: NVML cannot report it (NVML_VALUE_NOT_AVAILABLE, e.g. MIG or restricted containers). */
  usedBytes: Schema.NullOr(Schema.Finite),
});
export type NvmlProc = typeof NvmlProc.Type;

/** One round of the sampler: every card, the processes on them, the driver. */
export const NvmlSnapshot = Schema.Struct({
  gpus: Schema.Array(GpuReading),
  procs: Schema.Array(NvmlProc),
  system: NvmlSystem,
});
export type NvmlSnapshot = typeof NvmlSnapshot.Type;

/**
 * The server's commands. `start` once: the library to open (`LLAMA_WEBUI_NVML_LIB`, else `libnvidia-ml.so.1`), the
 * interval and what to read; `configure` when the settings change, applied from the next round.
 */
export const ToSampler = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('start'),
    intervalMs: Schema.Finite,
    needs: Needs,
    lib: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal('configure'), intervalMs: Schema.Finite, needs: Needs }),
]);
export type ToSampler = typeof ToSampler.Type;

/** The sampler's messages: `ready` once NVML is up, or `error` (it then stays idle); then one `sample` per round. */
export const FromSampler = Schema.Union([
  Schema.Struct({ type: Schema.Literal('ready') }),
  Schema.Struct({ type: Schema.Literal('error'), message: Schema.String }),
  Schema.Struct({ type: Schema.Literal('sample'), snapshot: NvmlSnapshot }),
]);
export type FromSampler = typeof FromSampler.Type;
