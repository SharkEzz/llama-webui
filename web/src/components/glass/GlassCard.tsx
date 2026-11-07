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
  children?: ReactNode;
}

/** Card shadcn en verre : fond --card translucide + flou ; visible au-delà de ses bords (menus de suggestions). */
export function GlassCard({ title, icon: Icon, actions, className, children }: GlassCardProps) {
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
      <CardContent>{children}</CardContent>
    </Card>
  );
}
