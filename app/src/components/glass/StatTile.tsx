import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { GLASS } from './glass';
import { TONE_VAR, type Tone } from './tones';

interface StatTileProps {
  label: string;
  value: string | number;
  unit?: string;
  hint?: string;
  tone?: Tone;
  /** Value in tabular mono (digits). Set to false for a text value. */
  mono?: boolean;
  className?: string;
}

/** Number tile: label, value in tabular mono, optional unit and hint. */
export function StatTile({ label, value, unit, hint, tone = 'blue', mono = true, className }: StatTileProps) {
  return (
    <Card size="sm" className={cn(GLASS, 'min-w-0 gap-2 rounded-md px-4 py-4', className)}>
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span className="size-1.5 shrink-0 rounded-full" style={{ background: TONE_VAR[tone] }} aria-hidden="true" />
        <span className="truncate">{label}</span>
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className={cn('truncate text-2xl font-medium leading-none tracking-tight', mono && 'num')}>{value}</span>
        {unit && <span className="text-sm text-muted-foreground">{unit}</span>}
      </div>
      {hint && <p className="truncate text-xs text-muted-foreground">{hint}</p>}
    </Card>
  );
}
