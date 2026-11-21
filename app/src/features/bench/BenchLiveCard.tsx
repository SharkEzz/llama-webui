import type { Measure } from '@llama-webui/shared';
import { Activity, Square } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { GlassCard } from '@/components/glass/GlassCard';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { KIND_LABEL, PHASE_LABEL, STATUS_LABEL, useBench } from '@/lib/bench';
import { formatDuration, formatRate, formatStddev } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import { formatAccept, modelName, vramTotal } from './format';

/** The current run (phase, progress, latest lines, Cancel), otherwise the last run's summary. */
export function BenchLiveCard() {
  const live = useBench((s) => s.live);
  const runs = useBench((s) => s.runs);
  const now = useNow(1000);
  const run = live ? runs.find((r) => r.id === live.runId) : runs[0];
  // Keep the latest lines visible: scroll to the bottom on every batch.
  const logRef = useRef<HTMLPreElement>(null);
  const lines = live?.lines;
  // biome-ignore lint/correctness/useExhaustiveDependencies: lines is a trigger: scroll to the bottom on every batch
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  if (!live) {
    return (
      <GlassCard title="Last run" icon={Activity}>
        {!run ? (
          <p className="text-sm text-muted-foreground">No runs yet: run a benchmark with the form.</p>
        ) : (
          <div className="flex flex-col gap-4">
            <RunHeader kind={run.kind} model={run.spec.modelPath} status={STATUS_LABEL[run.status]} />
            <dl className="grid grid-cols-2 gap-4">
              <Stat label="Prompt" value={formatRate(run.pp?.tps)} sub={deviation(run.pp)} />
              <Stat label="Generation" value={formatRate(run.tg?.tps)} sub={deviation(run.tg)} />
              <Stat label="Draft accepted" value={formatAccept(run.draftAcceptPct)} />
              <Stat label="Peak VRAM" value={vramTotal(run)} />
            </dl>
            {run.error && <p className="text-sm text-destructive">{run.error}</p>}
          </div>
        )}
      </GlassCard>
    );
  }

  const pct = live.step ? Math.round((live.step.index / Math.max(1, live.step.total)) * 100) : null;
  return (
    <GlassCard
      title="Running"
      icon={Activity}
      actions={
        // While the server restarts the run is over: nothing left to cancel.
        live.phase === 'restarting-server' ? (
          <span className="text-sm text-muted-foreground">Restarting server…</span>
        ) : (
          <Button variant="outline" size="sm" onClick={() => void useBench.getState().cancel()}>
            <Square /> Cancel
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-4">
        {run && <RunHeader kind={run.kind} model={run.spec.modelPath} />}
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between text-sm">
            <span className="font-medium">{PHASE_LABEL[live.phase]}</span>
            <span className="num text-muted-foreground">
              {live.step && `${live.step.index} / ${live.step.total} · `}
              {formatDuration(now - live.startedAt)}
            </span>
          </div>
          <Progress value={pct} aria-label="Benchmark progress" />
        </div>
        <pre
          ref={logRef}
          className="h-48 overflow-auto rounded-md bg-well inset-shadow-well p-3 font-mono text-[0.7rem] leading-relaxed text-muted-foreground"
        >
          {live.lines.join('\n') || '…'}
        </pre>
      </div>
    </GlassCard>
  );
}

function RunHeader({ kind, model, status }: { kind: 'bench' | 'server'; model: string; status?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant="secondary">{KIND_LABEL[kind]}</Badge>
      <span className="min-w-0 truncate font-mono text-sm">{modelName(model)}</span>
      {status && <span className="text-xs text-muted-foreground">{status}</span>}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="num text-lg font-semibold tracking-tight">{value}</dd>
      {sub && <dd className="num text-xs text-muted-foreground">{sub}</dd>}
    </div>
  );
}

const deviation = (m: Measure | null) =>
  m && m.stddev > 0 ? `${formatStddev(m.stddev).trim()} over ${m.tokens} tokens` : undefined;
