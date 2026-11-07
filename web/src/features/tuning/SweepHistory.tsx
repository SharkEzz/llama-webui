import { presetOf } from '@llama-webui/shared';
import { History } from 'lucide-react';
import { useNavigate } from 'react-router';
import { GlassCard } from '@/components/glass/GlassCard';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { dateFmt, modelName } from '@/features/bench/format';
import { useTuning } from '@/lib/tuning';
import { cn } from '@/lib/utils';
import { SWEEP_STATUS } from './SweepCard';

const nf = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });

/** Tous les sweeps ; une ligne ouvre le sweep (?sweep=<id>). */
export function SweepHistory() {
  const sweeps = useTuning((s) => s.sweeps);
  const loaded = useTuning((s) => s.sweepsLoaded);
  const openId = useTuning((s) => s.current?.sweep.id ?? null);
  const navigate = useNavigate();
  const go = (id: number) => navigate(`/tuning?sweep=${id}`);

  return (
    <GlassCard title="Sweeps" icon={History}>
      {!loaded ? (
        <Skeleton className="h-24" />
      ) : sweeps.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          Aucun sweep : composez un espace de recherche puis lancez-le.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nom</TableHead>
              <TableHead>Modèle</TableHead>
              <TableHead>Préréglage</TableHead>
              <TableHead className="text-right">ok / échecs / total</TableHead>
              <TableHead>Meilleur</TableHead>
              <TableHead>Statut</TableHead>
              <TableHead className="text-right">Date</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sweeps.map((s) => (
              <TableRow
                key={s.id}
                tabIndex={0}
                aria-selected={s.id === openId}
                className={cn('cursor-pointer', s.id === openId && 'bg-accent/60')}
                onClick={() => go(s.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    go(s.id);
                  }
                }}
              >
                <TableCell className="max-w-56 truncate font-medium">{s.name}</TableCell>
                <TableCell className="max-w-40 truncate font-mono text-xs" title={s.spec.modelPath}>
                  {modelName(s.spec.modelPath)}
                </TableCell>
                <TableCell className="text-xs">{presetOf(s.spec.preset).label}</TableCell>
                <TableCell className="num text-right text-xs">
                  {s.counts.ok} / {s.counts.failed} / {s.counts.total}
                </TableCell>
                <TableCell className="max-w-64 text-xs whitespace-normal">
                  {s.best ? (
                    <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="font-mono">{s.best.label?.replace(/^validation · /, '') ?? '—'}</span>
                      <span className="num shrink-0">
                        {s.best.tgTps === null ? '—' : `${nf.format(s.best.tgTps)} tok/s`}
                      </span>
                      {s.best.kind === 'server' && <Badge variant="secondary">serveur</Badge>}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell>
                  <Badge variant={SWEEP_STATUS[s.status].variant}>{SWEEP_STATUS[s.status].label}</Badge>
                </TableCell>
                <TableCell className="num text-right text-xs whitespace-nowrap">
                  {dateFmt.format(s.createdAt)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </GlassCard>
  );
}
