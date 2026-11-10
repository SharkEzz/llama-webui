import { CircleStop } from 'lucide-react';
import { Link } from 'react-router';
import { GLASS } from '@/components/glass/glass';
import { StatTile } from '@/components/glass/StatTile';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ServerStateBadge } from '@/features/server/ServerStateBadge';
import { formatInt, formatPct, num } from '@/lib/format';
import { useMonitor } from '@/lib/monitor';
import { useServer } from '@/lib/server';
import { cn } from '@/lib/utils';
import { ContextCard } from './ContextCard';
import { RequestsTable } from './RequestsTable';
import { SystemCard } from './SystemCard';
import { ThroughputCard } from './ThroughputCard';

const rate = (v: number) => num(1).format(v);

export function DashboardPage() {
  const snapshot = useMonitor((s) => s.snapshot);
  const state = useServer((s) => s.view?.state);
  const active = snapshot?.health != null;
  const spec = snapshot?.spec;
  const kv = snapshot?.kv;

  return (
    <div className="flex flex-col gap-4">
      {/* Above the fold: with a server, this block fills the viewport (p-4 + status bar + gap-4 = 5.5rem, see
          AppLayout) and the charts take the height the tiles leave. Slots and recent requests come below it. */}
      <div className={cn('flex flex-col gap-4', active && 'xl:min-h-[calc(100dvh-5.5rem)]')}>
        <header className="flex flex-wrap items-center gap-3">
          <h1 className="text-3xl font-semibold tracking-tight">Dashboard</h1>
          {state && <ServerStateBadge state={state} className="text-base" />}
        </header>

        {!active ? (
          <Alert className={GLASS}>
            <CircleStop />
            <AlertTitle>llama-server is stopped</AlertTitle>
            <AlertDescription>
              Throughput, slots and requests show up as soon as a server is running. The system is still measured.
            </AlertDescription>
            <AlertAction>
              <Button size="sm" nativeButton={false} render={<Link to="/server" />}>
                Start
              </Button>
            </AlertAction>
          </Alert>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile label="Generation" value={rate(snapshot.rates.genTps)} unit="tok/s" tone="blue" />
            <StatTile label="Prompt" value={rate(snapshot.rates.ppTps)} unit="tok/s" tone="teal" />
            {spec && spec.drafts > 0 && (
              <StatTile
                label="Speculative acceptance"
                value={spec.acceptCum === null ? '—' : formatPct(100 * spec.acceptCum)}
                hint={
                  spec.meanAcceptedPerDraft === null
                    ? undefined
                    : `${rate(spec.meanAcceptedPerDraft)} tokens accepted per draft`
                }
                tone="amber"
              />
            )}
            <StatTile
              label="Context used"
              value={kv ? formatPct((100 * kv.usedTokens) / kv.totalTokens) : '—'}
              hint={kv ? `${formatInt(kv.usedTokens)} / ${formatInt(kv.totalTokens)} tokens` : undefined}
              tone="rose"
            />
          </div>
        )}

        {/* The system card sits beside the charts from xl, never narrower than two of its meters side by side
            (30.5rem), or it would outgrow the charts; alone (no server) or stacked below, it takes the row. */}
        <div className={cn('grid gap-4', active && 'flex-1 xl:grid-cols-[minmax(0,3fr)_minmax(30.5rem,2fr)]')}>
          {active && (
            <div className="grid gap-4 xl:grid-rows-2">
              <ThroughputCard metric="generation" />
              <ThroughputCard metric="prompt" />
            </div>
          )}
          <SystemCard snapshot={snapshot} />
        </div>
      </div>

      {active && (
        <>
          <ContextCard snapshot={snapshot} loading={state?.kind === 'starting'} />
          <RequestsTable requests={snapshot.recentRequests} />
        </>
      )}
    </div>
  );
}
