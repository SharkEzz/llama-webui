import type { CpuInfo } from '@llama-webui/shared';
import { useEffect, useState } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { useMonitor } from '@/lib/monitor';
import { ChecksCard } from './ChecksCard';
import { CpuCard } from './CpuCard';
import { DiskCard } from './DiskCard';
import { GpuCard } from './GpuCard';
import { MemoryCard } from './MemoryCard';

export interface SystemInfo {
  cpu: CpuInfo;
  gpus: { key: string; name: string; vendor: 'nvidia' | 'amd'; busId: string; vramTotalBytes: number }[];
  nvidiaSource: 'nvml' | 'nvidia-smi';
}

export function SystemPage() {
  const snapshot = useMonitor((s) => s.snapshot);
  const [info, setInfo] = useState<SystemInfo | null>(null);
  useEffect(() => {
    void api<SystemInfo>('/system/info').then(setInfo, () => {});
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">System</h1>
        {info && (
          <span className="text-sm text-muted-foreground">
            NVIDIA source: {info.nvidiaSource === 'nvml' ? 'NVML' : 'nvidia-smi'}
          </span>
        )}
      </header>
      {!snapshot ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-64" />
          ))}
        </div>
      ) : (
        <>
          <div className="grid gap-4 xl:grid-cols-2">
            {snapshot.allGpus.map((g) => (
              <GpuCard key={g.key} gpu={g} />
            ))}
          </div>
          <div className="grid gap-4 xl:grid-cols-3">
            <CpuCard info={info?.cpu ?? null} sample={snapshot.system} />
            <MemoryCard sample={snapshot.system} />
            <DiskCard sample={snapshot.disk} />
          </div>
          <ChecksCard />
        </>
      )}
    </div>
  );
}
