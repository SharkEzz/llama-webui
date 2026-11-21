import type { Settings, SetupReport } from '@llama-webui/shared';
import { ArrowRight, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { GlassCard } from '@/components/glass/GlassCard';
import { Button } from '@/components/ui/button';
import { useProfiles } from '@/lib/profiles';
import type { SettingsErrors } from '@/lib/settings';
import { getSetup } from '@/lib/setup';
import { useTuning } from '@/lib/tuning';
import { cn } from '@/lib/utils';
import { BenchStep, BinaryStep, GpuStep, MachineStep, ModelsStep, NetworkStep, ProfileStep } from './steps';

/**
 * First-run checklist, on one page: two required steps (llama-server, models folder), the rest optional.
 * “Finish” records `onboardingDone`; Home then shows the launch pad.
 */
export function SetupChecklist({
  settings,
  errors,
  save,
  onFinish,
}: {
  settings: Settings;
  errors: SettingsErrors;
  save(patch: Partial<Settings>, o?: { quiet?: boolean }): Promise<boolean>;
  onFinish(): void;
}) {
  const [report, setReport] = useState<SetupReport | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true);
    return getSetup()
      .then(setReport, (e: Error) => toast.error(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => void refresh(), [refresh]);

  // Every step: the setup report, the machine checks (Tuning store) and the profiles.
  const checkAgain = () => {
    void useTuning.getState().loadChecks(null);
    void useProfiles.getState().reload();
    void refresh();
  };

  const saveAndCheck = async (patch: Partial<Settings>) => {
    if (await save(patch)) await refresh();
  };
  const steps = { report, settings, errors, save: saveAndCheck };
  const required = report ? [report.binary.path !== null, report.models.exists].filter(Boolean).length : 0;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight">Welcome to llama-webui</h1>
          <p className="max-w-prose text-muted-foreground">
            A few checks so llama-server runs well on this machine. Only the first two are required; everything else can
            be done later, from Settings or the System page.
          </p>
        </div>
        <Button variant="ghost" size="sm" disabled={loading} onClick={checkAgain}>
          <RefreshCw className={cn(loading && 'animate-spin')} /> Check again
        </Button>
      </header>

      <BinaryStep {...steps} />
      <ModelsStep {...steps} />
      <BenchStep report={report} />
      <GpuStep {...steps} />
      <MachineStep />
      <ProfileStep />
      <NetworkStep report={report} />

      <GlassCard>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {report?.ready
              ? 'Required steps done. You can come back to this checklist from Settings.'
              : `${required} of 2 required steps done: llama-server and the models folder.`}
          </p>
          <Button
            disabled={!report?.ready}
            onClick={() => void save({ onboardingDone: true }, { quiet: true }).then((ok) => ok && onFinish())}
          >
            Finish <ArrowRight />
          </Button>
        </div>
      </GlassCard>
    </div>
  );
}
