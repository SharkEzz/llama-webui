import type { LucideIcon } from 'lucide-react';
import { CircleCheck, CircleDashed, CircleX, Copy, Info, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { GlassCard } from '@/components/glass/GlassCard';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { copyText } from '@/lib/clipboard';
import { cn } from '@/lib/utils';

/** done: passes; todo: required and failing; warn: optional, could be better; info: nothing to do; loading. */
export type StepState = 'done' | 'todo' | 'warn' | 'info' | 'loading';

const STATE: Record<StepState, { icon: LucideIcon; className: string; label: string }> = {
  done: { icon: CircleCheck, className: 'text-success', label: 'Done' },
  todo: { icon: CircleX, className: 'text-destructive', label: 'Required' },
  warn: { icon: TriangleAlert, className: 'text-warning', label: 'To improve' },
  info: { icon: Info, className: 'text-tone-blue', label: 'Note' },
  loading: { icon: CircleDashed, className: 'text-muted-foreground animate-pulse', label: 'Checking…' },
};

export function Step({
  title,
  icon,
  state,
  optional,
  children,
}: {
  title: string;
  icon: LucideIcon;
  state: StepState;
  optional?: boolean;
  children: ReactNode;
}) {
  const s = STATE[state];
  const Icon = s.icon;
  return (
    <GlassCard
      title={title}
      icon={icon}
      actions={
        <>
          {optional && <Badge variant="secondary">optional</Badge>}
          <span className={cn('flex items-center gap-1.5 text-sm font-medium', s.className)}>
            <Icon className="size-4" aria-hidden="true" />
            {s.label}
          </span>
        </>
      }
    >
      <div className="flex flex-col gap-4 text-sm">{children}</div>
    </GlassCard>
  );
}

/** A shell command to run by hand, with a copy button. */
export function Command({ children }: { children: string }) {
  return (
    <div className="flex items-start gap-1.5 rounded-md bg-well inset-shadow-well py-1 pr-1 pl-2.5">
      <code className="min-w-0 flex-1 py-0.5 font-mono text-xs break-all">{children}</code>
      <Button variant="ghost" size="icon-xs" onClick={() => void copyText(children)} aria-label="Copy command">
        <Copy />
      </Button>
    </div>
  );
}
