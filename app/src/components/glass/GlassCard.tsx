import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { GLASS } from './glass';

interface GlassCardProps {
  title?: string;
  icon?: LucideIcon;
  actions?: ReactNode;
  className?: string;
  /** Classes of the content area, e.g. `flex min-h-0 flex-1 flex-col` for a content that fills a stretched card. */
  contentClassName?: string;
  children?: ReactNode;
}

/** Glass shadcn Card: translucent --card background + blur; visible beyond its edges (suggestion menus). */
export function GlassCard({ title, icon: Icon, actions, className, contentClassName, children }: GlassCardProps) {
  const hasHeader = Boolean(title || actions);
  return (
    <Card className={cn(GLASS, '[--card-spacing:--spacing(5)]', className)}>
      {hasHeader && (
        <CardHeader className="items-center">
          <CardTitle className="flex items-center gap-2.5 text-[0.9375rem] font-semibold tracking-tight">
            {Icon && <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
            {title && <h2>{title}</h2>}
          </CardTitle>
          {actions && <CardAction className="row-span-1 flex items-center gap-2">{actions}</CardAction>}
        </CardHeader>
      )}
      <CardContent className={contentClassName}>{children}</CardContent>
    </Card>
  );
}
