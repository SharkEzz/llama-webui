import type { LucideIcon } from 'lucide-react';
import type { CSSProperties, PointerEvent, ReactNode } from 'react';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { GLASS } from './glass';
import { TONE_VAR, type Tone } from './tones';

interface GlassCardProps {
  title?: string | undefined;
  icon?: LucideIcon | undefined;
  tone?: Tone | undefined;
  actions?: ReactNode;
  className?: string | undefined;
  /** Classes of the content area, e.g. `flex min-h-0 flex-1 flex-col` for a content that fills a stretched card. */
  contentClassName?: string | undefined;
  children?: ReactNode;
}

const ICON_TONE: Record<Tone, string> = {
  blue: 'text-tone-blue',
  teal: 'text-tone-teal',
  amber: 'text-tone-amber',
  rose: 'text-tone-rose',
};

/**
 * Obsidian Aurora glass shadcn Card: frosted --card background + blur + clipped cursor spotlight overlay so popovers
 * and suggestion menus remain unclipped (`overflow-visible`).
 */
export function GlassCard({ title, icon: Icon, tone, actions, className, contentClassName, children }: GlassCardProps) {
  const hasHeader = Boolean(title || actions);
  const style = tone ? ({ '--card-tone': TONE_VAR[tone] } as CSSProperties) : undefined;

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse') return;
    const rect = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty('--mx', `${e.clientX - rect.left}px`);
    e.currentTarget.style.setProperty('--my', `${e.clientY - rect.top}px`);
  };

  return (
    <Card
      onPointerMove={onPointerMove}
      style={style}
      className={cn(GLASS, 'app-spotlight [--card-spacing:--spacing(5)]', className)}
    >
      <div className="spotlight-layer" aria-hidden="true" />
      {hasHeader && (
        <CardHeader className="items-center">
          <CardTitle className="flex items-center gap-2.5 text-[0.9375rem] font-semibold tracking-tight">
            {Icon && (
              <Icon
                className={cn('size-4 shrink-0', tone ? ICON_TONE[tone] : 'text-muted-foreground')}
                aria-hidden="true"
              />
            )}
            {title && <h2>{title}</h2>}
          </CardTitle>
          {actions && <CardAction className="row-span-1 flex items-center gap-2">{actions}</CardAction>}
        </CardHeader>
      )}
      <CardContent className={contentClassName}>{children}</CardContent>
    </Card>
  );
}
