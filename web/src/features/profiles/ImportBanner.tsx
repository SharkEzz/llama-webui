import { Import } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { GlassCard } from '@/components/glass/GlassCard';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { importLlamaTui, importSummary, type LlamaTuiStatus, llamaTuiStatus } from '@/lib/profiles';

/** Proposé quand aucun profil n'existe et qu'une config llama-tui est présente. */
export function ImportBanner({ profileCount, onImported }: { profileCount: number; onImported(): void }) {
  const [status, setStatus] = useState<LlamaTuiStatus | null>(null);

  useEffect(() => {
    if (profileCount > 0) return;
    llamaTuiStatus().then(setStatus, () => {});
  }, [profileCount]);

  if (profileCount > 0 || !status || !status.exists || status.dismissed || status.names.length === 0) return null;
  const n = status.names.length;

  return (
    <GlassCard title="Profils llama-tui trouvés" icon={Import}>
      <p className="text-sm text-muted-foreground">
        {n} profil{n > 1 ? 's' : ''} dans <span className="font-mono text-xs">{status.path}</span> :{' '}
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
          Importer
        </Button>
        <Button
          variant="ghost"
          onClick={() =>
            api('/settings', { method: 'PATCH', body: JSON.stringify({ llamaTuiImportDismissed: true }) }).then(
              () => setStatus({ ...status, dismissed: true }),
              (e: Error) => toast.error(e.message),
            )
          }
        >
          Ignorer
        </Button>
      </div>
    </GlassCard>
  );
}
