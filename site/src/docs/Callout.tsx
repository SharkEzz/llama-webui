import { CircleAlert, Info, Lightbulb, type LucideIcon, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';

const TYPES: Record<string, { label: string; icon: LucideIcon; box: string; ink: string }> = {
  note: { label: 'Note', icon: Info, box: 'border-tone-blue/30 bg-tone-blue/6', ink: 'text-tone-blue' },
  tip: { label: 'Tip', icon: Lightbulb, box: 'border-tone-teal/30 bg-tone-teal/6', ink: 'text-tone-teal' },
  warning: {
    label: 'Warning',
    icon: TriangleAlert,
    box: 'border-tone-amber/35 bg-tone-amber/7',
    ink: 'text-tone-amber',
  },
  important: {
    label: 'Important',
    icon: CircleAlert,
    box: 'border-tone-rose/35 bg-tone-rose/6',
    ink: 'text-tone-rose',
  },
};

/** <Callout type="warning" title="…">Markdown</Callout>; the type's name is the default title. */
export function Callout({
  type = 'note',
  title,
  children,
}: {
  type?: 'note' | 'tip' | 'warning' | 'important';
  title?: string;
  children: React.ReactNode;
}) {
  const t = TYPES[type] ?? TYPES.note!;
  const Icon = t.icon;
  return (
    <aside className={cn('my-6 flex gap-3 rounded-xl border px-4 py-3.5 text-[0.9375rem]', t.box)}>
      <Icon className={cn('mt-1 size-4 shrink-0', t.ink)} aria-hidden="true" />
      <div className="min-w-0 [&>p]:my-0 [&>p+p]:mt-3 [&>ul]:my-2">
        <p className="font-semibold text-foreground">{title ?? t.label}</p>
        {children}
      </div>
    </aside>
  );
}
