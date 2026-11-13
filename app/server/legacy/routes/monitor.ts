import type { CpuInfo } from '@llama-webui/shared';
import { Hono } from 'hono';
import { readCpuInfo } from '../hardware/cpu';
import type { Env } from '../http';
import type { Monitor } from '../monitor/monitor';

export interface MonitorRouteDeps {
  monitor: Monitor;
  bootId: string;
}

let cpuInfo: Promise<CpuInfo> | null = null;

export const monitorRoutes = ({ monitor, bootId }: MonitorRouteDeps) =>
  new Hono<Env>()
    .get('/api/monitor/snapshot', (c) => c.json(monitor.latest()))
    .get('/api/monitor/history', (c) => c.json({ ...monitor.dump(), bootId }))
    .get('/api/system/info', async (c) => {
      cpuInfo ??= readCpuInfo();
      const gpus = (monitor.latest()?.allGpus ?? []).map(({ key, name, vendor, busId, vramTotalBytes }) => ({
        key,
        name,
        vendor,
        busId,
        vramTotalBytes,
      }));
      return c.json({ cpu: await cpuInfo, gpus, nvidiaSource: monitor.nvidiaSource });
    });
