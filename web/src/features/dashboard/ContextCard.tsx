import { type Snapshot, slotContextTokens } from '@llama-webui/shared';
import { Layers } from 'lucide-react';
import { GlassCard } from '@/components/glass/GlassCard';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { formatInt, formatPct } from '@/lib/format';

/** Slots (contexte occupé par slot) et file de requêtes. */
export function ContextCard({ snapshot }: { snapshot: Snapshot }) {
  const { slots, queue } = snapshot;
  return (
    <GlassCard title="Slots et contexte" icon={Layers}>
      <div className="flex flex-col gap-4">
        {!slots || slots.length === 0 ? (
          <p className="text-sm text-muted-foreground">/slots indisponible pour ce serveur.</p>
        ) : (
          slots.map((s) => {
            const used = slotContextTokens(s);
            const pct = s.nCtx > 0 ? (100 * used) / s.nCtx : 0;
            return (
              <div key={s.id} className="flex flex-col gap-1.5">
                <div className="flex items-baseline gap-2 text-sm">
                  <span className="font-medium">Slot {s.id}</span>
                  {s.processing ? (
                    <Badge variant="secondary" className="text-success">
                      en cours
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-muted-foreground">
                      libre
                    </Badge>
                  )}
                  <span className="ml-auto num text-xs text-muted-foreground">
                    {formatInt(used)} / {formatInt(s.nCtx)} ({formatPct(pct)})
                  </span>
                </div>
                <Progress value={Math.min(100, pct)} aria-label={`Contexte du slot ${s.id}`} />
              </div>
            );
          })
        )}
        <dl className="grid grid-cols-3 gap-2 border-t border-border pt-4 text-sm">
          <QueueStat label="En cours" value={queue?.processing} />
          <QueueStat label="En attente" value={queue?.deferred} />
          <QueueStat label="Slots occupés" value={queue?.busySlots} />
        </dl>
      </div>
    </GlassCard>
  );
}

function QueueStat({ label, value }: { label: string; value: number | undefined }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="num text-lg">{value === undefined ? '—' : formatInt(value)}</dd>
    </div>
  );
}
