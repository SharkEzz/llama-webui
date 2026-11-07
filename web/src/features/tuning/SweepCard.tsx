import { presetOf, type SweepStatus } from '@llama-webui/shared';
import { CheckCheck, ListOrdered, Play, Square, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { GlassCard } from '@/components/glass/GlassCard';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/Select';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { modelName } from '@/features/bench/format';
import { PHASE_LABEL } from '@/lib/bench';
import { formatDuration } from '@/lib/format';
import { useTuning } from '@/lib/tuning';
import { useNow } from '@/lib/useNow';
import { RankingTable } from './RankingTable';
import { StopServerDialog } from './StopServerDialog';

export const SWEEP_STATUS: Record<SweepStatus, { label: string; variant: 'secondary' | 'outline' | 'destructive' }> = {
  running: { label: 'en cours', variant: 'secondary' },
  done: { label: 'terminé', variant: 'outline' },
  cancelled: { label: 'annulé', variant: 'secondary' },
  interrupted: { label: 'interrompu', variant: 'destructive' },
};

const VALIDATE_ITEMS = [1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: `${n} meilleur${n > 1 ? 's' : ''}` }));

/** Le sweep ouvert : progression, élément en cours, actions (annuler, reprendre, valider, supprimer) et classement. */
export function SweepCard() {
  const current = useTuning((s) => s.current);
  const sweepLive = useTuning((s) => s.sweepLive);
  const live = useTuning((s) => s.live);
  const [n, setN] = useState('3');
  const [confirm, setConfirm] = useState<'resume' | 'validate' | null>(null);
  const now = useNow(1000);
  const logRef = useRef<HTMLPreElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: live.lines est un déclencheur : défilement en bas à chaque lot
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [live?.lines]);

  if (!current) return null;
  const { sweep, runs } = current;
  const c = sweep.counts;
  const running = sweep.status === 'running';
  const mine = sweepLive?.sweepId === sweep.id ? sweepLive : null;
  const item = mine?.runId != null ? runs.find((r) => r.id === mine.runId) : undefined;
  const itemLive = mine && live?.runId === mine.runId ? live : null;
  const done = c.total - c.queued - c.running;
  const finished = runs.filter((r) => r.status === 'ok' && r.durationMs !== null);
  const avgMs = finished.length ? finished.reduce((a, r) => a + r.durationMs!, 0) / finished.length : null;
  const left = avgMs !== null ? avgMs * (c.queued + c.running) : null;
  const explored = runs.some((r) => r.kind === 'bench' && r.status === 'ok');
  const { cancelSweep, resume, validate, removeSweep, open } = useTuning.getState();

  const act = async (what: 'resume' | 'validate', stopServer = false) => {
    const r = what === 'resume' ? await resume(sweep.id, stopServer) : await validate(sweep.id, Number(n), stopServer);
    if (r === 'confirm') setConfirm(what);
  };

  return (
    <GlassCard
      title={running ? 'Sweep en cours' : `Sweep « ${sweep.name} »`}
      icon={ListOrdered}
      actions={
        <>
          <Badge variant={SWEEP_STATUS[sweep.status].variant}>{SWEEP_STATUS[sweep.status].label}</Badge>
          {!running && (
            <Button variant="ghost" size="icon-sm" onClick={() => void open(null)} aria-label="Fermer le sweep">
              <X />
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
          {running && <span className="font-medium">{sweep.name}</span>}
          <span className="font-mono text-xs text-muted-foreground">{modelName(sweep.spec.modelPath)}</span>
          <span className="text-muted-foreground">{presetOf(sweep.spec.preset).label}</span>
          <span className="num text-muted-foreground">
            p {sweep.spec.p} · n {sweep.spec.n} · r {sweep.spec.r}
          </span>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
            <span>
              {mine ? (
                <>
                  {mine.stage === 'validate' ? 'Validation' : 'Élément'}{' '}
                  <span className="num">
                    {mine.index}/{mine.total}
                  </span>
                  {item?.sweepLabel && <span className="font-mono text-xs"> · {item.sweepLabel}</span>}
                  {itemLive && <span className="text-muted-foreground"> · {PHASE_LABEL[itemLive.phase]}</span>}
                </>
              ) : (
                <>
                  <span className="num">{done}</span> / <span className="num">{c.total}</span> exécutés
                </>
              )}
            </span>
            <span className="num text-xs text-muted-foreground">
              {c.ok} ok · {c.failed} échec{c.failed > 1 ? 's' : ''}
              {c.cancelled > 0 && ` · ${c.cancelled} annulé${c.cancelled > 1 ? 's' : ''}`}
              {c.interrupted > 0 && ` · ${c.interrupted} interrompu${c.interrupted > 1 ? 's' : ''}`}
              {running && ` · ${formatDuration(now - sweep.createdAt)}`}
              {running && left !== null && ` · reste ≈ ${formatDuration(left)}`}
            </span>
          </div>
          <Progress value={c.total ? (done / c.total) * 100 : 0} aria-label="Progression du sweep" />
        </div>

        {itemLive && (
          <pre
            ref={logRef}
            className="h-32 overflow-auto rounded-md bg-well inset-shadow-well p-3 font-mono text-[0.7rem] leading-relaxed text-muted-foreground"
          >
            {itemLive.lines.join('\n') || '…'}
          </pre>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {running && (
            <ConfirmDialog
              title="Annuler le sweep ?"
              description="L'élément en cours est arrêté et les éléments en attente sont annulés ; le serveur est relancé s'il avait été arrêté."
              confirmLabel="Annuler le sweep"
              destructive
              onConfirm={() => cancelSweep(sweep.id)}
              trigger={
                <Button variant="outline" size="sm">
                  <Square /> Annuler le sweep
                </Button>
              }
            />
          )}
          {sweep.status === 'interrupted' && (
            <Button size="sm" onClick={() => void act('resume')}>
              <Play /> Reprendre
            </Button>
          )}
          {!running && (
            <div className="flex items-center gap-2">
              <Select items={VALIDATE_ITEMS} value={n} onValueChange={(v) => v && setN(v)}>
                <SelectTrigger size="sm" className="w-36" aria-label="Nombre de configurations à valider">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VALIDATE_ITEMS.map((i) => (
                    <SelectItem key={i.value} value={i.value}>
                      {i.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                variant="outline"
                disabled={!explored}
                title={explored ? undefined : "aucun run d'exploration réussi"}
                onClick={() => void act('validate')}
              >
                <CheckCheck /> Valider sur le serveur
              </Button>
            </div>
          )}
          {!running && (
            <ConfirmDialog
              title={`Supprimer le sweep « ${sweep.name} » ?`}
              description={`Ses ${c.total} runs seront définitivement supprimés, de l'historique Benchmark aussi.`}
              confirmLabel="Supprimer"
              destructive
              onConfirm={() => removeSweep(sweep.id)}
              trigger={
                <Button variant="ghost" size="sm" className="ml-auto">
                  <Trash2 /> Supprimer le sweep
                </Button>
              }
            />
          )}
        </div>

        <RankingTable sweep={sweep} runs={runs} />
      </div>
      <StopServerDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        onConfirm={() => confirm && void act(confirm, true)}
      />
    </GlassCard>
  );
}
