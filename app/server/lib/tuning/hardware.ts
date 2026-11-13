import type { CpuInfo, GpuSample, MemInfo, TuningHardware } from '@llama-webui/shared';
import { listDevicesResult } from '../bench/hardware';
import { parseMeminfo } from '../collectors/system';
import { readCpuInfo } from '../hardware/cpu';
import { readText } from '../proc';
import { withLiveMemory } from './match';

let cpu: Promise<CpuInfo> | null = null;

/**
 * Devices from `llama-bench --list-devices` with their live memory (`gpus`: the monitor's `allGpus`), CPU, RAM (from
 * the latest snapshot, otherwise /proc/meminfo).
 */
export async function readTuningHardware(o: {
  benchBinary: string;
  mem: MemInfo | null;
  gpus?: GpuSample[];
}): Promise<TuningHardware> {
  cpu ??= readCpuInfo();
  const mem = o.mem ?? parseMeminfo(await readText('/proc/meminfo').catch(() => ''));
  const list = await listDevicesResult(o.benchBinary);
  return {
    devices: withLiveMemory(list.devices, o.gpus ?? []),
    devicesError: list.error,
    cpu: await cpu,
    ramTotalBytes: mem?.totalBytes ?? 0,
    ramAvailableBytes: mem?.availableBytes ?? 0,
  };
}
