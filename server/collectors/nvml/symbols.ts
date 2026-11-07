import { dlopen, FFIType as T } from 'bun:ffi';

/**
 * The subset of NVML used by llama-tui. Names are the C symbols; device handles are
 * pointers passed as numbers; out-params are Buffers; every call returns an nvmlReturn_t.
 */
export interface NvmlSymbols {
  nvmlInit_v2(): number;
  nvmlShutdown(): number;
  nvmlDeviceGetCount_v2(count: Buffer): number;
  nvmlDeviceGetHandleByIndex_v2(i: number, out: Buffer): number;
  nvmlDeviceGetName(h: number, buf: Buffer, len: number): number;
  nvmlDeviceGetUUID(h: number, buf: Buffer, len: number): number;
  nvmlDeviceGetPciInfo_v3(h: number, out: Buffer): number;
  nvmlDeviceGetUtilizationRates(h: number, out: Buffer): number;
  nvmlDeviceGetMemoryInfo_v2(h: number, out: Buffer): number;
  nvmlDeviceGetTemperature(h: number, sensor: number, out: Buffer): number;
  nvmlDeviceGetPowerUsage(h: number, out: Buffer): number;
  nvmlDeviceGetPowerManagementLimit(h: number, out: Buffer): number;
  nvmlDeviceGetPowerManagementDefaultLimit(h: number, out: Buffer): number;
  nvmlDeviceGetPersistenceMode(h: number, out: Buffer): number;
  nvmlSystemGetDriverVersion(buf: Buffer, len: number): number;
  nvmlSystemGetCudaDriverVersion(out: Buffer): number;
  nvmlDeviceGetClockInfo(h: number, type: number, out: Buffer): number;
  nvmlDeviceGetMaxClockInfo(h: number, type: number, out: Buffer): number;
  nvmlDeviceGetFanSpeed(h: number, out: Buffer): number;
  nvmlDeviceGetPcieThroughput(h: number, counter: number, out: Buffer): number;
  nvmlDeviceGetCurrPcieLinkGeneration(h: number, out: Buffer): number;
  nvmlDeviceGetCurrPcieLinkWidth(h: number, out: Buffer): number;
  nvmlDeviceGetMaxPcieLinkGeneration(h: number, out: Buffer): number;
  nvmlDeviceGetMaxPcieLinkWidth(h: number, out: Buffer): number;
  nvmlDeviceGetComputeRunningProcesses_v3(h: number, count: Buffer, infos: Buffer): number;
}

const ret = T.i32;
const outFn = { args: [T.ptr, T.ptr], returns: ret } as const;
const typedOutFn = { args: [T.ptr, T.u32, T.ptr], returns: ret } as const;

/** dlopen libnvidia-ml; throws when the library or a symbol is missing. */
export function openNvml(path = 'libnvidia-ml.so.1'): NvmlSymbols {
  const { symbols } = dlopen(path, {
    nvmlInit_v2: { args: [], returns: ret },
    nvmlShutdown: { args: [], returns: ret },
    nvmlDeviceGetCount_v2: { args: [T.ptr], returns: ret },
    nvmlDeviceGetHandleByIndex_v2: { args: [T.u32, T.ptr], returns: ret },
    nvmlDeviceGetName: { args: [T.ptr, T.ptr, T.u32], returns: ret },
    nvmlDeviceGetUUID: { args: [T.ptr, T.ptr, T.u32], returns: ret },
    nvmlDeviceGetPciInfo_v3: outFn,
    nvmlDeviceGetUtilizationRates: outFn,
    nvmlDeviceGetMemoryInfo_v2: outFn,
    nvmlDeviceGetTemperature: typedOutFn,
    nvmlDeviceGetPowerUsage: outFn,
    nvmlDeviceGetPowerManagementLimit: outFn,
    nvmlDeviceGetPowerManagementDefaultLimit: outFn,
    nvmlDeviceGetPersistenceMode: outFn,
    nvmlSystemGetDriverVersion: { args: [T.ptr, T.u32], returns: ret },
    nvmlSystemGetCudaDriverVersion: { args: [T.ptr], returns: ret },
    nvmlDeviceGetClockInfo: typedOutFn,
    nvmlDeviceGetMaxClockInfo: typedOutFn,
    nvmlDeviceGetFanSpeed: outFn,
    nvmlDeviceGetPcieThroughput: typedOutFn,
    nvmlDeviceGetCurrPcieLinkGeneration: outFn,
    nvmlDeviceGetCurrPcieLinkWidth: outFn,
    nvmlDeviceGetMaxPcieLinkGeneration: outFn,
    nvmlDeviceGetMaxPcieLinkWidth: outFn,
    nvmlDeviceGetComputeRunningProcesses_v3: { args: [T.ptr, T.ptr, T.ptr], returns: ret },
  });
  return symbols as unknown as NvmlSymbols;
}
