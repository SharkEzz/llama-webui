import { Import } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { GlassCard } from '@/components/glass/GlassCard';
import { Button } from '@/components/ui/button';
import { call, client } from '@/lib/api';
import { plural } from '@/lib/format';
import { importLlamaTui, importSummary, type LlamaTuiStatus, llamaTuiStatus } from '@/lib/profiles';

/** Offered when no profile exists and a llama-tui config is present. */
export function ImportBanner({ profileCount, onImported }: { profileCount: number; onImported(): void }) {
  const [status, setStatus] = useState<LlamaTuiStatus | null>(null);

  useEffect(() => {
    if (profileCount > 0) return;
    llamaTuiStatus().then(setStatus, () => {});
  }, [profileCount]);

  if (profileCount > 0 || !status || !status.exists || status.dismissed || status.names.length === 0) return null;
  const n = status.names.length;

  return (
    <GlassCard title="llama-tui profiles found" icon={Import}>
      <p className="text-sm text-muted-foreground">
        {n} {plural(n, 'profile')} in <span className="font-mono text-xs">{status.path}</span>:{' '}
        {status.names.join(', ')}.
      </p>
      <div className="mt-4 flex gap-2">
        <Button
          onClick={() =>
            importLlamaTui().then(
              (r) => {
                toast.success(importSummary(r));
                onImported();
              },
              (e: Error) => toast.error(e.message),
            )
          }
        >
          Import
        </Button>
        <Button
          variant="ghost"
          onClick={() =>
            call(client.settings.$patch({ json: { llamaTuiImportDismissed: true } })).then(
              () => setStatus({ ...status, dismissed: true }),
              (e: Error) => toast.error(e.message),
            )
          }
        >
          Dismiss
        </Button>
      </div>
    </GlassCard>
  );
}
