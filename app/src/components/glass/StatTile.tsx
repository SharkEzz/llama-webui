import type { CSSProperties, PointerEvent } from 'react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { GLASS } from './glass';
import { TONE_VAR, type Tone } from './tones';

interface StatTileProps {
  label: string;
  value: string | number;
  unit?: string | undefined;
  hint?: string | undefined;
  tone?: Tone | undefined;
  /** Value in tabular mono (digits). Set to false for a text value. */
  mono?: boolean | undefined;
  className?: string | undefined;
}

/** Number tile: frosted glass, tone-tinted cursor spotlight, glowing tone dot, tabular value, unit and hint. */
export function StatTile({ label, value, unit, hint, tone = 'blue', mono = true, className }: StatTileProps) {
  const color = TONE_VAR[tone];
  const style: CSSProperties & { '--card-tone': string } = { '--card-tone': color };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse') return;
    const rect = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty('--mx', `${e.clientX - rect.left}px`);
    e.currentTarget.style.setProperty('--my', `${e.clientY - rect.top}px`);
  };

  return (
    <Card
      size="sm"
      onPointerMove={onPointerMove}
      style={style}
      className={cn(GLASS, 'app-spotlight min-w-0 gap-2 rounded-xl p-4', className)}
    >
      <div className="spotlight-layer" aria-hidden="true" />
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span
          className="size-2 shrink-0 rounded-full"
          style={{ background: color, boxShadow: `0 0 10px color-mix(in oklch, ${color} 70%, transparent)` }}
          aria-hidden="true"
        />
        <span className="truncate">{label}</span>
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className={cn('truncate text-2xl leading-none font-medium tracking-tight', mono && 'num')}>{value}</span>
        {unit && <span className="text-sm text-muted-foreground">{unit}</span>}
      </div>
      {hint && <p className="truncate text-xs text-muted-foreground">{hint}</p>}
    </Card>
  );
}
