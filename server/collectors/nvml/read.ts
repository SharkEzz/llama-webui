import { type GpuReading, identityReading, normalizeBusId } from "../gpu";
import { type GpuNeeds, gpuSkipped, MEASURE_ALL } from "../needs";
import type { NvmlSymbols } from "./symbols";

export interface NvmlProc {
  pid: number;
  key: string;
  /** null: NVML cannot report it (NVML_VALUE_NOT_AVAILABLE, e.g. MIG or restricted containers). */
  usedBytes: number | null;
}

/** NVML_VALUE_NOT_AVAILABLE for unsigned long long fields. */
const VALUE_NOT_AVAILABLE = 0xffffffffffffffffn;

export interface NvmlSystem {
  /** "580.95.05"; null when NVML cannot tell. */
  driver: string | null;
  /** 13000 = CUDA 13.0, the newest runtime the driver supports; null when unknown. */
  cudaDriver: number | null;
}

export interface NvmlSnapshot {
  gpus: GpuReading[];
  procs: NvmlProc[];
  system: NvmlSystem;
}

const SUCCESS = 0;
const INSUFFICIENT_SIZE = 7;
const STR_LEN = 96;
const MEMORY_V2_SIZE = 40;
const MEMORY_V2_VERSION = MEMORY_V2_SIZE | (2 << 24);
const PCI_INFO_SIZE = 68;
const PCI_BUS_ID_OFFSET = 36;
const PROC_INFO_SIZE = 24;
const CLOCK_GRAPHICS = 0;
const CLOCK_MEM = 2;
const PCIE_TX = 0;
const PCIE_RX = 1;

const cString = (buf: Buffer, from = 0, to = buf.length): string => {
  const end = buf.indexOf(0, from);
  return buf.toString("utf8", from, end < 0 || end > to ? to : end);
};

/** Driver and CUDA driver versions; null for whatever NVML refuses. */
export function readNvmlSystem(lib: NvmlSymbols): NvmlSystem {
  const str = Buffer.alloc(STR_LEN);
  const driver = lib.nvmlSystemGetDriverVersion(str, STR_LEN) === SUCCESS ? cString(str) : null;
  const u32 = Buffer.alloc(4);
  const cudaDriver = lib.nvmlSystemGetCudaDriverVersion(u32) === SUCCESS ? u32.readInt32LE(0) : null;
  return { driver, cudaDriver };
}

export function deviceHandles(lib: NvmlSymbols): number[] {
  const count = Buffer.alloc(4);
  if (lib.nvmlDeviceGetCount_v2(count) !== SUCCESS) return [];
  const handles: number[] = [];
  const out = Buffer.alloc(8);
  for (let i = 0; i < count.readUInt32LE(0); i++) {
    if (lib.nvmlDeviceGetHandleByIndex_v2(i, out) === SUCCESS) handles.push(Number(out.readBigUInt64LE(0)));
  }
  return handles;
}

function readProcs(lib: NvmlSymbols, h: number, key: string): NvmlProc[] {
  const count = Buffer.alloc(4);
  let cap = 64;
  for (let attempt = 0; attempt < 2; attempt++) {
    count.writeUInt32LE(cap, 0);
    const infos = Buffer.alloc(cap * PROC_INFO_SIZE);
    const rc = lib.nvmlDeviceGetComputeRunningProcesses_v3(h, count, infos);
    if (rc === INSUFFICIENT_SIZE) {
      cap = count.readUInt32LE(0) + 8; // processes may appear between the two calls
      continue;
    }
    if (rc !== SUCCESS) return [];
    const n = Math.min(count.readUInt32LE(0), cap);
    const out: NvmlProc[] = [];
    for (let i = 0; i < n; i++) {
      out.push({
        pid: infos.readUInt32LE(i * PROC_INFO_SIZE),
        key,
        usedBytes: ((v) => (v === VALUE_NOT_AVAILABLE ? null : Number(v)))(
          infos.readBigUInt64LE(i * PROC_INFO_SIZE + 8),
        ),
      });
    }
    return out;
  }
  return [];
}

/**
 * One reading per device, and the processes on it. `filter`: cards no tab shows are only identified (UUID,
 * name, bus id); PCIe throughput, which blocks ~50 ms per card, is read only when some tab shows it.
 */
export function readNvml(lib: NvmlSymbols, handles: number[], filter: GpuNeeds = MEASURE_ALL): NvmlSnapshot {
  const gpus: GpuReading[] = [];
  const procs: NvmlProc[] = [];
  const u32 = Buffer.alloc(4);
  const one = (rc: number, mul = 1, div = 1): number | null =>
    rc === SUCCESS ? (u32.readUInt32LE(0) * mul) / div : null;

  for (const h of handles) {
    const str = Buffer.alloc(STR_LEN);
    if (lib.nvmlDeviceGetUUID(h, str, STR_LEN) !== SUCCESS) continue;
    const uuid = cString(str);
    const key = `nvidia:${uuid}`;
    const name = lib.nvmlDeviceGetName(h, str.fill(0), STR_LEN) === SUCCESS ? cString(str) : "NVIDIA GPU";
    const pci = Buffer.alloc(PCI_INFO_SIZE);
    const busId =
      lib.nvmlDeviceGetPciInfo_v3(h, pci) === SUCCESS
        ? normalizeBusId(cString(pci, PCI_BUS_ID_OFFSET, PCI_INFO_SIZE))
        : "";
    if (gpuSkipped(filter, busId)) {
      gpus.push(identityReading({ key, vendor: "nvidia", name, busId }, "hidden"));
      continue;
    }

    const mem = Buffer.alloc(MEMORY_V2_SIZE);
    mem.writeUInt32LE(MEMORY_V2_VERSION, 0);
    const memOk = lib.nvmlDeviceGetMemoryInfo_v2(h, mem) === SUCCESS; // unknown VRAM reads as 0, the GPU stays listed
    const util = Buffer.alloc(8);
    const utilOk = lib.nvmlDeviceGetUtilizationRates(h, util) === SUCCESS;
    const power = one(lib.nvmlDeviceGetPowerUsage(h, u32), 1, 1000);
    const limit = one(lib.nvmlDeviceGetPowerManagementLimit(h, u32), 1, 1000);
    const defaultLimit = one(lib.nvmlDeviceGetPowerManagementDefaultLimit(h, u32), 1, 1000);
    const persistence = one(lib.nvmlDeviceGetPersistenceMode(h, u32));

    gpus.push({
      key,
      vendor: "nvidia",
      name,
      busId,
      utilPct: utilOk ? util.readUInt32LE(0) : null,
      memUtilPct: utilOk ? util.readUInt32LE(4) : null,
      vramUsedBytes: memOk ? Number(mem.readBigUInt64LE(32)) : 0,
      vramTotalBytes: memOk ? Number(mem.readBigUInt64LE(8)) : 0,
      tempC: one(lib.nvmlDeviceGetTemperature(h, 0, u32)),
      powerW: power,
      powerLimitW: limit,
      powerDefaultLimitW: defaultLimit,
      persistence: persistence === null ? null : persistence === 1,
      clockGrMhz: one(lib.nvmlDeviceGetClockInfo(h, CLOCK_GRAPHICS, u32)),
      clockGrMaxMhz: one(lib.nvmlDeviceGetMaxClockInfo(h, CLOCK_GRAPHICS, u32)),
      clockMemMhz: one(lib.nvmlDeviceGetClockInfo(h, CLOCK_MEM, u32)),
      fanPct: one(lib.nvmlDeviceGetFanSpeed(h, u32)),
      pcieGen: one(lib.nvmlDeviceGetCurrPcieLinkGeneration(h, u32)),
      pcieWidth: one(lib.nvmlDeviceGetCurrPcieLinkWidth(h, u32)),
      pcieGenMax: one(lib.nvmlDeviceGetMaxPcieLinkGeneration(h, u32)),
      pcieWidthMax: one(lib.nvmlDeviceGetMaxPcieLinkWidth(h, u32)),
      pcieRxBps: filter.pcie ? one(lib.nvmlDeviceGetPcieThroughput(h, PCIE_RX, u32), 1024) : null,
      pcieTxBps: filter.pcie ? one(lib.nvmlDeviceGetPcieThroughput(h, PCIE_TX, u32), 1024) : null,
    });
    procs.push(...readProcs(lib, h, key));
  }
  return { gpus, procs, system: readNvmlSystem(lib) };
}
