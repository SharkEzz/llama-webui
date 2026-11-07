import type { CpuInfo, MemInfo, TuningHardware } from '@llama-webui/shared';
import { listDevices } from '../bench/hardware';
import { parseMeminfo } from '../collectors/system';
import { readCpuInfo } from '../hardware/cpu';

let cpu: Promise<CpuInfo> | null = null;

/** Devices de `llama-bench --list-devices`, CPU, RAM (du dernier snapshot, sinon /proc/meminfo). */
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
