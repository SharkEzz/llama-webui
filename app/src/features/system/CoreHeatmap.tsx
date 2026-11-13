import { type KeyboardEvent, useRef, useState } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatPct } from '@/lib/format';

const STEP: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/**
 * One cell per logical core, filled bottom-up (--chart-1) by its load. Each cell is a button (the tooltip also opens from the
 * keyboard), with a roving tabindex: a single Tab stop for the whole grid, arrows and Home/End move through it.
 */
export function CoreHeatmap({ cores }: { cores: number[] }) {
  const [active, setActive] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  const current = Math.min(active, Math.max(0, cores.length - 1));

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const last = cores.length - 1;
    let next: number;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    else if (e.key in STEP) next = Math.min(last, Math.max(0, current + (STEP[e.key] ?? 0)));
    else return;
    e.preventDefault();
    setActive(next);
    list.current?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
  };

  return (
    <ul
      ref={list}
      className="grid grid-cols-[repeat(auto-fill,minmax(2.75rem,1fr))] gap-1"
      aria-label="Load per core"
      onKeyDown={onKeyDown}
    >
      {cores.map((pct, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: one cell per core, the index is the core's identity
        <li key={i}>
          <Tooltip>
            <TooltipTrigger
              tabIndex={i === current ? 0 : -1}
              onFocus={() => setActive(i)}
              className="relative flex h-9 w-full items-center justify-center overflow-hidden rounded-md border border-border text-[0.65rem] text-muted-foreground outline-none num focus-visible:ring-3 focus-visible:ring-ring/50"
              aria-label={`Core ${i}: ${formatPct(pct)}`}
            >
              <span
                aria-hidden="true"
                className="absolute inset-x-0 bottom-0 bg-chart-1/60 transition-[height] duration-300 ease-out motion-reduce:transition-none"
                style={{ height: `${Math.min(100, Math.max(0, pct))}%` }}
              />
              <span className="relative">{i}</span>
            </TooltipTrigger>
            <TooltipContent>
              Core {i}: {formatPct(pct)}
            </TooltipContent>
          </Tooltip>
        </li>
      ))}
    </ul>
  );
}
