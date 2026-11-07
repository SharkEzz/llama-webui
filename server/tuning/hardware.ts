import type { CpuInfo, MemInfo, TuningHardware } from '@llama-webui/shared';
import { listDevices } from '../bench/hardware';
import { parseMeminfo } from '../collectors/system';
import { readCpuInfo } from '../hardware/cpu';

let cpu: Promise<CpuInfo> | null = null;

/** Devices from `llama-bench --list-devices`, CPU, RAM (from the latest snapshot, otherwise /proc/meminfo). */
export async function readTuningHardware(o: { benchBinary: string; mem: MemInfo | null }): Promise<TuningHardware> {
  cpu ??= readCpuInfo();
  const mem =
    o.mem ??
    parseMeminfo(
      await Bun.file('/proc/meminfo')
        .text()
        .catch(() => ''),
    );
  return {
    devices: await listDevices(o.benchBinary),
    cpu: await cpu,
    ramTotalBytes: mem?.totalBytes ?? 0,
    ramAvailableBytes: mem?.availableBytes ?? 0,
  };
}
