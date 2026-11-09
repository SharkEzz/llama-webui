import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * The app's glass card without the backdrop blur: inside the hero window the page behind is static, and dozens of
 * blurred layers under a 3D transform would cost frames for no visible difference.
 */
export const PANEL = 'rounded-lg bg-card shadow-surface inset-shadow-highlight ring-1 ring-surface-border';

export function Panel({
  title,
  icon: Icon,
  className,
  children,
}: {
  title?: string;
  icon?: LucideIcon;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn(PANEL, 'flex flex-col gap-4 p-5', className)}>
      {title && (
        <div className="flex items-center gap-2.5 text-[0.9375rem] font-semibold tracking-tight">
          {Icon && <Icon className="size-4 shrink-0 text-muted-foreground" />}
          {title}
        </div>
      )}
      {children}
    </div>
  );
}

/** Number tile (web/src/components/glass/StatTile.tsx): tone dot, label, value in tabular mono, unit, hint. */
export function StatTile({
  label,
  value,
  unit,
  hint,
  tone,
}: {
  label: string;
  value: string;
  unit?: string;
  hint?: string;
  tone: string;
}) {
  return (
    <div className={cn(PANEL, 'flex min-w-0 flex-col gap-2 rounded-md px-4 py-4')}>
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span className="size-1.5 shrink-0 rounded-full" style={{ background: tone }} />
        <span className="truncate">{label}</span>
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="num truncate text-2xl font-medium leading-none tracking-tight">{value}</span>
        {unit && <span className="text-sm text-muted-foreground">{unit}</span>}
      </div>
      {hint && <p className="truncate text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
