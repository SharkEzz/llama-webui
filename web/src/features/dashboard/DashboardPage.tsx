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
import { ContextCard } from './ContextCard';
import { RequestsTable } from './RequestsTable';
import { SystemStrip } from './SystemStrip';
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
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">Dashboard</h1>
        {state && <ServerStateBadge state={state} className="text-base" />}
      </header>

      {!active ? (
        <Alert className={GLASS}>
          <CircleStop />
          <AlertTitle>llama-server is stopped</AlertTitle>
          <AlertDescription>
            Throughput, slots and requests show up as soon as a server is running. The system strip is still measured.
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

      <SystemStrip snapshot={snapshot} />

      {active && (
        <>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <ThroughputCard />
            <ContextCard snapshot={snapshot} />
          </div>
          <RequestsTable requests={snapshot.recentRequests} />
        </>
      )}
    </div>
  );
}
