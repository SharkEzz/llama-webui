import { useNavigate } from 'react-router';
import { Skeleton } from '@/components/ui/skeleton';
import { useSettingsEditor } from '@/lib/settings';
import { Launchpad } from './launchpad/Launchpad';
import { SetupChecklist } from './setup/SetupChecklist';

/** `/`: the setup checklist until it is finished, then the launch pad. */
export function HomePage() {
  const { settings, errors, save } = useSettingsEditor();
  if (!settings) return <Skeleton className="h-72" />;
  if (settings.onboardingDone) return <Launchpad />;
  // Finishing updates `settings`: the launch pad replaces the checklist.
  return <SetupChecklist settings={settings} errors={errors} save={save} onFinish={() => {}} />;
}

/** `/setup`: the checklist, always (reopened from Settings or the launch pad). */
export function SetupPage() {
  const { settings, errors, save } = useSettingsEditor();
  const navigate = useNavigate();
  if (!settings) return <Skeleton className="h-72" />;
  return <SetupChecklist settings={settings} errors={errors} save={save} onFinish={() => void navigate('/')} />;
}
