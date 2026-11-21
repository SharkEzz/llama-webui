import {
  type BenchRun,
  type BenchStatus,
  isOomError,
  NOISE,
  type Ranked,
  rankRuns,
  type Sweep,
  sweepCtx,
} from '@llama-webui/shared';
import { Copy, ExternalLink, MoreHorizontal, Star, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatAccept, vramTotal } from '@/features/bench/format';
import { STATUS_LABEL } from '@/lib/bench';
import { copyText } from '@/lib/clipboard';
import { fmt, formatDuration, formatInt, formatStddev } from '@/lib/format';
import { useTuning } from '@/lib/tuning';
import { cn } from '@/lib/utils';
import { VerdictBadge } from './PlanTable';
import { RankBars } from './RankBars';

const BARS = 8;
const NOISE_TEXT = `tied with the first: gap below the measurement noise (pp ±${NOISE.pp * 100}%, tg ±${NOISE.tg * 100}%)`;
const STATUS_VARIANT: Record<BenchStatus, 'secondary' | 'outline' | 'destructive'> = {
  queued: 'outline',
  running: 'secondary',
  ok: 'outline',
  failed: 'destructive',
  cancelled: 'secondary',
  interrupted: 'secondary',
};

/** A sweep's ranking: exploration (llama-bench) and validation (server) kept apart, never mixed. */
export function RankingTable({ sweep, runs }: { sweep: Sweep; runs: BenchRun[] }) {
  const ctx = sweepCtx(sweep.spec);
  const explore = rankRuns(
    runs.filter((r) => r.kind === 'bench'),
    sweep.spec.preset,
    ctx,
  );
  const validate = rankRuns(
    runs.filter((r) => r.kind === 'server'),
    sweep.spec.preset,
    ctx,
  );
  // The saved best, otherwise (deleted from Benchmark) the one from the displayed ranking.
  const bestId =
    sweep.bestRunId ?? (validate.find((r) => r.rank === 1) ?? explore.find((r) => r.rank === 1))?.run.id ?? null;
  const top = explore.filter((r) => r.rank !== null).slice(0, BARS);

  return (
    <div className="flex flex-col gap-6">
      {validate.length > 0 && (
        <Ranking title="Validation (server)" ranked={validate} bestId={bestId} ctx={ctx} server />
      )}
      <Ranking title="Exploration (llama-bench)" ranked={explore} bestId={bestId} ctx={ctx} />
      {top.length > 1 && (
        <div className="flex flex-col gap-2">
          <RankBars ranked={top} />
          <p className="text-xs text-muted-foreground">
            Best configurations of the exploration. Thin line: ± one standard deviation. Configurations whose gap to the
            first is below the noise (pp ±{NOISE.pp * 100}%, tg ±{NOISE.tg * 100}%) are tied (“1=”); llama-bench
            measures neither speculative decoding nor -c: the server validation settles it.
          </p>
        </div>
      )}
    </div>
  );
}

function Ranking({
  title,
  ranked,
  bestId,
  ctx,
  server = false,
}: {
  title: string;
  ranked: Ranked[];
  bestId: number | null;
  ctx: number;
  server?: boolean;
}) {
  const navigate = useNavigate();
  // An exploration run that “does not fit”: llama-bench measured it without reserving the profile's context, so the profile may OOM.
  const [unfit, setUnfit] = useState<BenchRun | null>(null);
  const toProfile = async (run: BenchRun) => {
    const p = await useTuning.getState().toProfile(run.id);
    if (p) navigate(`/profiles?id=${p.id}`);
  };
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{title}</h3>
      {ranked.length === 0 ? (
        <p className="text-sm text-muted-foreground">No runs.</p>
      ) : (
        <Table className="[&_td]:px-1.5 [&_th]:px-1.5">
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">Rank</TableHead>
              <TableHead>Configuration</TableHead>
              <TableHead>Estimated</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Prompt</TableHead>
              <TableHead className="text-right">Generation</TableHead>
              {server && (
                <TableHead className="text-right" title="Speculative decoding: draft tokens accepted">
                  Draft
                </TableHead>
              )}
              <TableHead className="text-right">Peak VRAM</TableHead>
              <TableHead className="text-right">Duration</TableHead>
              <TableHead className="w-8">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ranked.map((r) => {
              const best = r.run.id === bestId;
              return (
                <TableRow key={r.run.id} className={cn(best && 'bg-accent/60 hover:bg-accent')}>
                  <TableCell className="num text-xs">
                    {r.rank === null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : r.tie ? (
                      <Tooltip>
                        <TooltipTrigger render={<span />} className="underline decoration-dotted underline-offset-4">
                          1=
                        </TooltipTrigger>
                        <TooltipContent>{NOISE_TEXT}</TooltipContent>
                      </Tooltip>
                    ) : (
                      r.rank
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs whitespace-normal">
                    <span className="flex items-center gap-1.5">
                      {best && <Star className="size-3.5 shrink-0 fill-current text-primary-ink" aria-label="best" />}
                      {r.run.sweepLabel?.replace(/^validation · /, '') ?? `#${r.run.id}`}
                    </span>
                  </TableCell>
                  <TableCell>
                    {r.run.fit ? (
                      <VerdictBadge verdict={r.run.fit} />
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <StatusBadge run={r.run} />
                  </TableCell>
                  <Measure m={r.run.pp} />
                  <Measure m={r.run.tg} />
                  {server && (
                    <TableCell className="num text-right text-xs">{formatAccept(r.run.draftAcceptPct)}</TableCell>
                  )}
                  <TableCell className="num text-right text-xs whitespace-nowrap">
                    {r.run.vramPeak.length ? vramTotal(r.run) : '—'}
                  </TableCell>
                  <TableCell className="num text-right text-xs whitespace-nowrap">
                    {r.run.durationMs === null ? '—' : formatDuration(r.run.durationMs)}
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={<Button variant="ghost" size="icon-xs" />}
                        aria-label={`Actions for ${r.run.sweepLabel ?? r.run.id}`}
                      >
                        <MoreHorizontal />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="min-w-48">
                        <DropdownMenuItem
                          disabled={r.run.status !== 'ok'}
                          onClick={() => (!server && r.run.fit === 'no' ? setUnfit(r.run) : void toProfile(r.run))}
                        >
                          <UserPlus /> Create profile
                        </DropdownMenuItem>
                        <DropdownMenuItem disabled={!r.run.command} onClick={() => void copyText(r.run.command)}>
                          <Copy /> Copy command
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => navigate(`/bench?run=${r.run.id}`)}>
                          <ExternalLink /> View in Benchmark
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      <AlertDialog open={unfit !== null} onOpenChange={(o) => !o && setUnfit(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>This configuration does not fit with the target context</AlertDialogTitle>
            <AlertDialogDescription>
              llama-bench measured <span className="font-mono">{unfit?.sweepLabel}</span> with its test alone (prompt
              and generation), without reserving the <span className="num">{formatInt(ctx)}</span>-token context. Per
              the estimate, the profile may run out of memory at startup. Validate it on the server first, or lower -c
              in the created profile.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const run = unfit;
                setUnfit(null);
                if (run) void toProfile(run);
              }}
            >
              Create anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function StatusBadge({ run }: { run: BenchRun }) {
  const oom = run.status === 'failed' && isOomError(run.error);
  const badge = <Badge variant={STATUS_VARIANT[run.status]}>{oom ? 'out of memory' : STATUS_LABEL[run.status]}</Badge>;
  if (!run.error) return badge;
  return (
    <Tooltip>
      <TooltipTrigger render={<span />}>{badge}</TooltipTrigger>
      <TooltipContent className="max-w-md">{run.error}</TooltipContent>
    </Tooltip>
  );
}

function Measure({ m }: { m: BenchRun['pp'] }) {
  return (
    <TableCell className="num text-right text-xs whitespace-nowrap">
      {m ? fmt(m.tps, 1) : '—'}
      {m && m.stddev > 0 && <div className="text-[0.7rem] text-muted-foreground">{formatStddev(m.stddev).trim()}</div>}
    </TableCell>
  );
}
