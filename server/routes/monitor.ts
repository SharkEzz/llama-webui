import type { CpuInfo } from '@llama-webui/shared';
import { readCpuInfo } from '../hardware/cpu';
import { guarded } from '../http';
import type { Monitor } from '../monitor/monitor';

export interface MonitorRouteDeps {
  monitor: Monitor;
  bootId: string;
}

let cpuInfo: Promise<CpuInfo> | null = null;

export function monitorRoutes({ monitor, bootId }: MonitorRouteDeps) {
  return {
    '/api/monitor/snapshot': { GET: guarded(() => Response.json(monitor.latest())) },
    '/api/monitor/history': { GET: guarded(() => Response.json({ ...monitor.dump(), bootId })) },
    '/api/system/info': {
      GET: guarded(async () => {
        cpuInfo ??= readCpuInfo();
        const gpus = (monitor.latest()?.allGpus ?? []).map(({ key, name, vendor, busId, vramTotalBytes }) => ({
          key,
          name,
          vendor,
          busId,
          vramTotalBytes,
        }));
        return Response.json({ cpu: await cpuInfo, gpus, nvidiaSource: monitor.nvidiaSource });
      }),
    },
  };
}
