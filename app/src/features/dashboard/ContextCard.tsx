import {
  type LoadProgress,
  loadProgressPct,
  loadStageLabel,
  type Snapshot,
  slotContextTokens,
} from '@llama-webui/shared';
import { Layers } from 'lucide-react';
import { GlassCard } from '@/components/glass/GlassCard';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { formatInt, formatPct } from '@/lib/format';

/** Slots (context used per slot) and request queue; `loading` while the model loads (no /slots yet). */
export function ContextCard({
  snapshot,
  loading = false,
  loadProgress = null,
  sleeping = false,
}: {
  snapshot: Snapshot;
  loading?: boolean;
  loadProgress?: LoadProgress | null;
  sleeping?: boolean;
}) {
  const { slots, queue } = snapshot;
  const loadPct = loadProgress ? loadProgressPct(loadProgress) : null;
  return (
    <GlassCard title="Slots and context" icon={Layers} tone="rose">
      <div className="flex flex-col gap-4">
        {!slots || slots.length === 0 ? (
          loading && loadProgress ? (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-2 text-sm text-muted-foreground">
                <span>Loading {loadStageLabel(loadProgress.current).toLowerCase()}…</span>
                {loadPct !== null && <span className="num text-xs">{formatPct(loadPct)}</span>}
              </div>
              <Progress value={loadPct} aria-label="Model loading progress" />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {loading
                ? 'Loading the model…'
                : sleeping
                  ? 'Model is sleeping (unloaded from memory); it will reload on the next request.'
                  : '/slots unavailable for this server.'}
            </p>
          )
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
                      busy
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-muted-foreground">
                      free
                    </Badge>
                  )}
                  <span className="ml-auto num text-xs text-muted-foreground">
                    {formatInt(used)} / {formatInt(s.nCtx)} ({formatPct(pct)})
                  </span>
                </div>
                <Progress value={Math.min(100, pct)} aria-label={`Slot ${s.id} context`} />
              </div>
            );
          })
        )}
        <dl className="grid grid-cols-3 gap-2 border-t border-border pt-4 text-sm">
          <QueueStat label="Processing" value={queue?.processing} />
          <QueueStat label="Queued" value={queue?.deferred} />
          <QueueStat label="Busy slots" value={queue?.busySlots} />
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
