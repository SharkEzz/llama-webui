import type { CpuInfo } from '@llama-webui/shared';
import { defineHandler } from 'nitro';
import { deps } from '../../../lib/context.ts';
import { readCpuInfo } from '../../../lib/hardware/cpu.ts';
import { reply } from '../../../lib/http.ts';

let cpuInfo: Promise<CpuInfo> | null = null;

export default defineHandler(async () => {
  const { monitor } = deps();
  cpuInfo ??= readCpuInfo();
  const gpus = (monitor.latest()?.allGpus ?? []).map(({ key, name, vendor, busId, vramTotalBytes }) => ({
    key,
    name,
    vendor,
    busId,
    vramTotalBytes,
  }));
  return reply({ cpu: await cpuInfo, gpus, nvidiaSource: monitor.nvidiaSource });
});
