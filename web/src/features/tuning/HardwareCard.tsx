import { DEVICE_ROLE_BADGE, deviceRole } from '@llama-webui/shared';
import { Cpu, ListChecks, TriangleAlert } from 'lucide-react';
import { Link } from 'react-router';
import { GlassCard } from '@/components/glass/GlassCard';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatBytes } from '@/lib/format';
import { useTuning } from '@/lib/tuning';
import { cn } from '@/lib/utils';

const MiB = 1024 ** 2;

/** llama.cpp devices (--list-devices), RAM and CPU: what the estimator splits the model across. */
export function HardwareCard() {
  const hw = useTuning((s) => s.hardware);
  return (
    <GlassCard
      title="Hardware"
      icon={Cpu}
      actions={
        <Button variant="ghost" size="sm" render={<Link to="/system" />} nativeButton={false}>
          <ListChecks /> Checks
        </Button>
      }
    >
      {!hw ? (
        <Skeleton className="h-40" />
      ) : (
        <div className="flex flex-col gap-3 text-sm">
          {hw.devicesError && (
            <p className="flex items-start gap-1.5 text-xs text-warning">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
              <span>
                {hw.devicesError}
                {hw.devices.length > 0 ? ': showing the last good list.' : '.'} Stop llama-server and reload if devices
                are missing.
              </span>
            </p>
          )}
          <ul className="flex flex-col gap-2">
            {hw.devices
              .filter((d) => d.totalMib > 0)
              .map((d) => {
                const role = DEVICE_ROLE_BADGE[deviceRole(d, hw.devices)];
                return (
                  <li key={d.id} className={cn('flex flex-col', role && 'text-muted-foreground')}>
                    <span className="flex items-baseline gap-2">
                      <span className="font-mono text-xs">{d.id}</span>
                      {role && <Badge variant="outline">{role}</Badge>}
                      <span className="num ml-auto shrink-0 text-xs">
                        {formatBytes(d.freeMib * MiB)}{' '}
                        <span className="text-muted-foreground">/ {formatBytes(d.totalMib * MiB)}</span>
                      </span>
                    </span>
                    <span className="truncate text-xs text-muted-foreground" title={d.name}>
                      {d.name}
                    </span>
                    {!role && (d.otherUsedMib ?? 0) >= 256 && (
                      <span className="num text-xs text-muted-foreground">
                        {formatBytes((d.otherUsedMib ?? 0) * MiB)} used by other processes
                      </span>
                    )}
                  </li>
                );
              })}
            {hw.devices.length === 0 && !hw.devicesError && (
              <li className="text-muted-foreground">No devices: check the binary in Settings.</li>
            )}
          </ul>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 border-t pt-3">
            <dt className="text-muted-foreground">RAM</dt>
            <dd className="num text-right">
              {formatBytes(hw.ramAvailableBytes)}{' '}
              <span className="text-muted-foreground">available / {formatBytes(hw.ramTotalBytes)}</span>
            </dd>
            <dt className="text-muted-foreground">CPU</dt>
            <dd className="min-w-0 truncate text-right" title={hw.cpu.model}>
              {hw.cpu.physicalCores} cores · {hw.cpu.model}
            </dd>
          </dl>
          <p className="text-xs text-muted-foreground">
            Duplicates (one card seen by two backends) and the iGPU are not offered by the estimator.
          </p>
        </div>
      )}
    </GlassCard>
  );
}
