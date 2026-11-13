import type { LaunchpadEntry, SetupReport } from '@llama-webui/shared';
import { ListChecks, SlidersHorizontal, TriangleAlert, Wand2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { GlassCard } from '@/components/glass/GlassCard';
import { GLASS } from '@/components/glass/glass';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useServer } from '@/lib/server';
import { getLaunchpad, getSetup } from '@/lib/setup';
import { ProfileCard } from './ProfileCard';

/** What broke since the setup (null: nothing). */
function setupProblem(r: SetupReport): string | null {
  const parts = [
    r.binary.path === null && `llama-server cannot be found (${r.binary.setting}).`,
    !r.models.exists && `The models folder is missing (${r.models.dir}).`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : null;
}

/** Home once set up: every profile, started in one click. */
export function Launchpad() {
  const [entries, setEntries] = useState<LaunchpadEntry[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const view = useServer((s) => s.view);
  const busy = useServer((s) => s.busy);

  useEffect(() => {
    void getLaunchpad().then(setEntries, (e: Error) => toast.error(e.message));
    void getSetup().then(
      (r) => setProblem(setupProblem(r)),
      () => {},
    );
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight">Launch pad</h1>
          <p className="text-muted-foreground">Start a profile in one click, then chat or watch it on the Dashboard.</p>
        </div>
        <Button variant="ghost" size="sm" nativeButton={false} render={<Link to="/setup" />}>
          <ListChecks /> Setup checklist
        </Button>
      </header>

      {problem && (
        <Alert className={GLASS}>
          <TriangleAlert />
          <AlertTitle>Setup incomplete</AlertTitle>
          <AlertDescription>{problem}</AlertDescription>
          <AlertAction>
            <Button size="sm" nativeButton={false} render={<Link to="/setup" />}>
              Fix
            </Button>
          </AlertAction>
        </Alert>
      )}

      {!entries ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
        </div>
      ) : entries.length === 0 ? (
        <GlassCard title="No profile yet" icon={SlidersHorizontal}>
          <p className="text-sm text-muted-foreground">
            A profile is a model plus its llama-server arguments. Create one by hand, or let Tuning recommend settings
            for your hardware.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button nativeButton={false} render={<Link to="/profiles" />}>
              <SlidersHorizontal /> Create a profile
            </Button>
            <Button variant="outline" nativeButton={false} render={<Link to="/tuning" />}>
              <Wand2 /> Get a recommendation
            </Button>
          </div>
        </GlassCard>
      ) : (
        <div className="grid items-stretch gap-4 md:grid-cols-2 xl:grid-cols-3">
          {entries.map((e) => (
            <ProfileCard key={e.profileId} entry={e} view={view} busy={busy} />
          ))}
        </div>
      )}
    </div>
  );
}
