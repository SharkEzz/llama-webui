import { useLocation } from 'react-router';
import { MILESTONE_BY_PATH, ROUTES } from '@/app/routes';
import { GlassCard } from '@/components/glass/GlassCard';

export function PlaceholderPage({ title }: { title: string }) {
  const { pathname } = useLocation();
  const route = ROUTES.find((r) => r.path === pathname);
  const milestone = MILESTONE_BY_PATH[pathname];
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
      <GlassCard icon={route?.icon} title={milestone ? 'Page en construction' : undefined}>
        <p className="text-sm text-muted-foreground">
          {milestone
            ? `Disponible au jalon ${milestone}.`
            : 'Cette adresse ne correspond à aucune page. Choisissez une section dans le menu.'}
        </p>
      </GlassCard>
    </div>
  );
}
