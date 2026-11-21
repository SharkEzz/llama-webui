import { dlopen } from 'node:ffi';

/**
 * The subset of NVML used by llama-tui. Names are the C symbols; device handles are pointers, kept as `bigint`
 * (never `Number()`: an address may not fit); out-params are Buffers; every call returns an nvmlReturn_t.
 */
export interface NvmlSymbols {
  nvmlInit_v2(): number;
  nvmlShutdown(): number;
  nvmlDeviceGetCount_v2(count: Buffer): number;
  nvmlDeviceGetHandleByIndex_v2(i: number, out: Buffer): number;
  nvmlDeviceGetName(h: bigint, buf: Buffer, len: number): number;
  nvmlDeviceGetUUID(h: bigint, buf: Buffer, len: number): number;
  nvmlDeviceGetPciInfo_v3(h: bigint, out: Buffer): number;
  nvmlDeviceGetUtilizationRates(h: bigint, out: Buffer): number;
  nvmlDeviceGetMemoryInfo_v2(h: bigint, out: Buffer): number;
  nvmlDeviceGetTemperature(h: bigint, sensor: number, out: Buffer): number;
  nvmlDeviceGetPowerUsage(h: bigint, out: Buffer): number;
  nvmlDeviceGetPowerManagementLimit(h: bigint, out: Buffer): number;
  nvmlDeviceGetPowerManagementDefaultLimit(h: bigint, out: Buffer): number;
  nvmlDeviceGetPersistenceMode(h: bigint, out: Buffer): number;
  nvmlSystemGetDriverVersion(buf: Buffer, len: number): number;
  nvmlSystemGetCudaDriverVersion(out: Buffer): number;
  nvmlDeviceGetClockInfo(h: bigint, type: number, out: Buffer): number;
  nvmlDeviceGetMaxClockInfo(h: bigint, type: number, out: Buffer): number;
  nvmlDeviceGetFanSpeed(h: bigint, out: Buffer): number;
  nvmlDeviceGetPcieThroughput(h: bigint, counter: number, out: Buffer): number;
  nvmlDeviceGetCurrPcieLinkGeneration(h: bigint, out: Buffer): number;
  nvmlDeviceGetCurrPcieLinkWidth(h: bigint, out: Buffer): number;
  nvmlDeviceGetMaxPcieLinkGeneration(h: bigint, out: Buffer): number;
  nvmlDeviceGetMaxPcieLinkWidth(h: bigint, out: Buffer): number;
  nvmlDeviceGetComputeRunningProcesses_v3(h: bigint, count: Buffer, infos: Buffer): number;
}

const ret = 'int32';
const outFn = { arguments: ['pointer', 'buffer'], return: ret } as const;
const typedOutFn = { arguments: ['pointer', 'uint32', 'buffer'], return: ret } as const;

/** dlopen libnvidia-ml; throws when the library or a symbol is missing. The typed `dlopen` checks that every
 * function of `NvmlSymbols` is defined, with compatible arguments. */
export function openNvml(path = 'libnvidia-ml.so.1'): NvmlSymbols {
  const { functions } = dlopen(path, {
    nvmlInit_v2: { arguments: [], return: ret },
    nvmlShutdown: { arguments: [], return: ret },
    nvmlDeviceGetCount_v2: { arguments: ['buffer'], return: ret },
    nvmlDeviceGetHandleByIndex_v2: { arguments: ['uint32', 'buffer'], return: ret },
    nvmlDeviceGetName: { arguments: ['pointer', 'buffer', 'uint32'], return: ret },
    nvmlDeviceGetUUID: { arguments: ['pointer', 'buffer', 'uint32'], return: ret },
    nvmlDeviceGetPciInfo_v3: outFn,
    nvmlDeviceGetUtilizationRates: outFn,
    nvmlDeviceGetMemoryInfo_v2: outFn,
    nvmlDeviceGetTemperature: typedOutFn,
    nvmlDeviceGetPowerUsage: outFn,
    nvmlDeviceGetPowerManagementLimit: outFn,
    nvmlDeviceGetPowerManagementDefaultLimit: outFn,
    nvmlDeviceGetPersistenceMode: outFn,
    nvmlSystemGetDriverVersion: { arguments: ['buffer', 'uint32'], return: ret },
    nvmlSystemGetCudaDriverVersion: { arguments: ['buffer'], return: ret },
    nvmlDeviceGetClockInfo: typedOutFn,
    nvmlDeviceGetMaxClockInfo: typedOutFn,
    nvmlDeviceGetFanSpeed: outFn,
    nvmlDeviceGetPcieThroughput: typedOutFn,
    nvmlDeviceGetCurrPcieLinkGeneration: outFn,
    nvmlDeviceGetCurrPcieLinkWidth: outFn,
    nvmlDeviceGetMaxPcieLinkGeneration: outFn,
    nvmlDeviceGetMaxPcieLinkWidth: outFn,
    nvmlDeviceGetComputeRunningProcesses_v3: { arguments: ['pointer', 'buffer', 'buffer'], return: ret },
  });
  return functions;
}
