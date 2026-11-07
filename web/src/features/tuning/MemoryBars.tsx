import type { DeviceBudget, Fit } from '@llama-webui/shared';
import { CircleAlert, TriangleAlert } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatBytes } from '@/lib/format';
import { cn } from '@/lib/utils';

type Level = 'fits' | 'tight' | 'over';

const levelOf = (bytes: number, budget: number): Level =>
  bytes <= 0.95 * budget ? 'fits' : bytes <= budget ? 'tight' : 'over';

const FILL: Record<Level, string> = { fits: 'bg-chart-1', tight: 'bg-warning', over: 'bg-destructive' };

/**
 * One gauge per device, then RAM: fill = estimated memory over total memory, tick = usable budget.
 * A single hue; “tight” and “over” take the status colors, always with a text label.
 */
export function MemoryBars({
  fit,
  names,
  ramTotalBytes,
}: {
  fit: Fit;
  names: Record<string, string>;
  ramTotalBytes: number;
}) {
  const ram: DeviceBudget = {
    device: 'RAM',
    bytes: fit.ramBytes,
    budget: fit.ramAvailableBytes,
    totalBytes: Math.max(ramTotalBytes, fit.ramAvailableBytes),
  };
  return (
    <div className="flex flex-col gap-3">
      {fit.vram.map((d) => (
        <Bar key={d.device} d={d} name={names[d.device] ?? ''} />
      ))}
      <Bar d={ram} name="System memory" ram />
    </div>
  );
}

function Bar({ d, name, ram = false }: { d: DeviceBudget; name: string; ram?: boolean }) {
  const level = levelOf(d.bytes, d.budget);
  const total = Math.max(1, d.totalBytes);
  const pct = (x: number) => `${Math.min(100, (x / total) * 100)}%`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={<div />}
        className="flex flex-col gap-1.5 rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        tabIndex={0}
      >
        <div className="flex items-baseline gap-2 text-sm">
          <span className="font-mono font-medium">{d.device}</span>
          <span className="num ml-auto text-xs whitespace-nowrap">
            {formatBytes(d.bytes)}{' '}
            <span className="text-muted-foreground">
              / {formatBytes(d.budget)} {ram ? 'available' : 'usable'}
            </span>
          </span>
        </div>
        <div className="relative h-2 rounded-full bg-muted">
          <div className={cn('absolute inset-y-0 left-0 rounded-full', FILL[level])} style={{ width: pct(d.bytes) }} />
          <div
            className="absolute -inset-y-0.5 w-0.5 rounded-full bg-foreground/60"
            style={{ left: pct(d.budget) }}
            aria-hidden="true"
          />
        </div>
        {level !== 'fits' && (
          <span
            className={cn('flex items-center gap-1 text-xs', level === 'tight' ? 'text-warning' : 'text-destructive')}
          >
            {level === 'tight' ? <TriangleAlert className="size-3.5" /> : <CircleAlert className="size-3.5" />}
            {level === 'tight'
              ? 'tight: less than 5% headroom'
              : ram
                ? `${formatBytes(d.bytes - d.budget)} over: read back from disk (mmap)`
                : `${formatBytes(d.bytes - d.budget)} over`}
          </span>
        )}
      </TooltipTrigger>
      <TooltipContent className="num">
        <div className="font-sans font-medium">{name}</div>
        <div>Estimated: {formatBytes(d.bytes)}</div>
        <div>
          {ram ? 'Available' : 'Usable (headroom deducted)'}: {formatBytes(d.budget)}
        </div>
        <div>Total: {formatBytes(d.totalBytes)}</div>
      </TooltipContent>
    </Tooltip>
  );
}
