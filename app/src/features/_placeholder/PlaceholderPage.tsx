import { useLocation } from 'react-router';
import { MILESTONE_BY_PATH, ROUTES } from '@/app/routes';
import { GlassCard } from '@/components/glass/GlassCard';

/** A page that is not there yet: `milestone` (else the one of the current path) brings it back. */
export function PlaceholderPage({ title, milestone: given }: { title: string; milestone?: string }) {
  const { pathname } = useLocation();
  const route = ROUTES.find((r) => r.path === pathname);
  const milestone = given ?? MILESTONE_BY_PATH[pathname];
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
      <GlassCard icon={route?.icon} title={milestone ? 'Not ported yet' : undefined}>
        <p className="text-sm text-muted-foreground">
          {milestone
            ? `Back with milestone ${milestone} of the Effect server rewrite.`
            : 'This address does not match any page. Pick a section from the menu.'}
        </p>
      </GlassCard>
    </div>
  );
}
