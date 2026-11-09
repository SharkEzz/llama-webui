import type { BenchRun, BenchStatus, Measure } from '@llama-webui/shared';
import { Copy, GitCompare, History, MoreHorizontal, RotateCcw, Trash2, UserPlus } from 'lucide-react';
import { useEffect, useEffectEvent, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { GlassCard } from '@/components/glass/GlassCard';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/Select';
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
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { type BenchFilters, KIND_LABEL, STATUS_LABEL, useBench } from '@/lib/bench';
import { copyText } from '@/lib/clipboard';
import { formatDuration, formatRate, formatShortDate, formatStddev } from '@/lib/format';
import { cn } from '@/lib/utils';
import { BenchCompareDialog } from './BenchCompareDialog';
import { flagsOf, formatAccept, formatMib, modelName, vramTotal } from './format';

const MAX_COMPARE = 4;
const STATUS_VARIANT: Record<BenchStatus, 'secondary' | 'outline' | 'destructive'> = {
  queued: 'outline',
  running: 'secondary',
  ok: 'outline',
  failed: 'destructive',
  cancelled: 'secondary',
  interrupted: 'secondary',
};

/** Filterable history (tool, model, status), selection for comparison, per-run actions. */
export function BenchHistory() {
  const runs = useBench((s) => s.runs);
  const loaded = useBench((s) => s.loaded);
  const filters = useBench((s) => s.filters);
  const selected = useBench((s) => s.selected);
  const { setFilters, toggle } = useBench.getState();
  const [comparing, setComparing] = useState(false);
  const [deleting, setDeleting] = useState<BenchRun | null>(null);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const focus = Number(params.get('run')) || null;

  // ?run=<id> (from Tuning): history including sweeps, row selected and scrolled into view, then the parameter is removed.
  // selected and setParams are read fresh without re-running the effect (triggered by ?run, the filters and the runs).
  const focusRun = useEffectEvent((id: number) => {
    if (!selected.includes(id)) toggle(id);
    // After the form has laid out (devices load lazily), otherwise the scroll targets a stale position.
    setTimeout(
      () => document.getElementById(`bench-run-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
      400,
    );
    setParams({}, { replace: true });
  });
  useEffect(() => {
    if (focus === null) return;
    if (filters.sweeps !== 'all') return setFilters({ sweeps: 'all' });
    if (!runs.some((r) => r.id === focus)) return;
    focusRun(focus);
  }, [focus, filters.sweeps, runs, setFilters]);

  const models = useMemo(() => [...new Set(runs.map((r) => r.spec.modelPath))].sort(), [runs]);
  const shown = runs.filter(
    (r) =>
      (filters.kind === 'all' || r.kind === filters.kind) &&
      (filters.model === 'all' || r.spec.modelPath === filters.model) &&
      (filters.status === 'all' || r.status === filters.status),
  );
  const compared = selected.map((id) => runs.find((r) => r.id === id)).filter((r): r is BenchRun => r !== undefined);

  const toProfile = async (id: number) => {
    const p = await useBench.getState().toProfile(id);
    if (p) navigate(`/profiles?id=${p.id}`);
  };

  return (
    <GlassCard
      title="History"
      icon={History}
      actions={
        <>
          <ConfirmDialog
            title="Delete failed runs?"
            description="Failed, cancelled and interrupted runs will be permanently deleted."
            confirmLabel="Delete"
            destructive
            onConfirm={() => useBench.getState().removeFailed()}
            trigger={
              <Button variant="ghost" size="sm">
                <Trash2 /> Delete failed
              </Button>
            }
          />
          <Button size="sm" variant="outline" disabled={compared.length < 2} onClick={() => setComparing(true)}>
            <GitCompare /> Compare ({compared.length})
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-3">
          <FilterSelect
            label="Tool"
            value={filters.kind}
            items={[
              { value: 'all', label: 'All tools' },
              { value: 'bench', label: 'llama-bench' },
              { value: 'server', label: 'Server' },
            ]}
            onChange={(v) => setFilters({ kind: v as BenchFilters['kind'] })}
          />
          <FilterSelect
            label="Model"
            value={filters.model}
            items={[{ value: 'all', label: 'All models' }, ...models.map((m) => ({ value: m, label: modelName(m) }))]}
            onChange={(v) => setFilters({ model: v })}
            wide
          />
          <FilterSelect
            label="Status"
            value={filters.status}
            items={[
              { value: 'all', label: 'All statuses' },
              ...Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label })),
            ]}
            onChange={(v) => setFilters({ status: v as BenchFilters['status'] })}
          />
          <FilterSelect
            label="Sweeps"
            value={filters.sweeps}
            items={[
              { value: 'none', label: 'Without sweeps' },
              { value: 'all', label: 'With sweeps' },
            ]}
            onChange={(v) => setFilters({ sweeps: v as BenchFilters['sweeps'] })}
          />
        </div>

        {!loaded ? (
          <Skeleton className="h-32" />
        ) : shown.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {runs.length === 0 ? 'No saved runs.' : 'No runs match the filters.'}
          </p>
        ) : (
          <Table className="[&_td]:px-1.5 [&_th]:px-1.5">
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">
                  <span className="sr-only">Selection</span>
                </TableHead>
                <TableHead>Run</TableHead>
                <TableHead>Tool</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Flags</TableHead>
                {filters.sweeps === 'all' && <TableHead>Sweep</TableHead>}
                <TableHead className="text-right">Prompt</TableHead>
                <TableHead className="text-right">Generation</TableHead>
                <TableHead
                  className="text-right"
                  title="Speculative decoding: draft tokens accepted (MTP, draft model or n-gram)"
                >
                  Draft
                </TableHead>
                <TableHead className="text-right">Peak VRAM</TableHead>
                <TableHead className="text-right">Duration</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-8">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((r) => {
                const checked = selected.includes(r.id);
                return (
                  <TableRow key={r.id} id={`bench-run-${r.id}`} data-state={checked ? 'selected' : undefined}>
                    <TableCell>
                      <Checkbox
                        checked={checked}
                        disabled={!checked && selected.length >= MAX_COMPARE}
                        onCheckedChange={() => toggle(r.id)}
                        aria-label={`Select run #${r.id} for comparison`}
                      />
                    </TableCell>
                    <TableCell className="num whitespace-nowrap text-xs">
                      #{r.id}
                      <div className="text-[0.7rem] text-muted-foreground">{formatShortDate(r.createdAt)}</div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{KIND_LABEL[r.kind]}</Badge>
                    </TableCell>
                    <TableCell
                      className={cn('truncate font-mono text-xs', filters.sweeps === 'all' ? 'max-w-28' : 'max-w-36')}
                      title={r.spec.modelPath}
                    >
                      {modelName(r.spec.modelPath)}
                    </TableCell>
                    <TableCell className={filters.sweeps === 'all' ? 'max-w-28' : 'max-w-36'}>
                      <Tooltip>
                        <TooltipTrigger
                          render={<span />}
                          className="block truncate font-mono text-xs text-muted-foreground"
                        >
                          {flagsOf(r)}
                        </TooltipTrigger>
                        <TooltipContent className="max-w-md font-mono">{r.command}</TooltipContent>
                      </Tooltip>
                    </TableCell>
                    {filters.sweeps === 'all' && (
                      <TableCell className="max-w-20 text-xs">
                        {r.sweepId === null ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <Link
                            to={`/tuning?sweep=${r.sweepId}`}
                            className="block truncate underline-offset-4 hover:underline"
                            title={r.sweepLabel ?? undefined}
                          >
                            #{r.sweepId} <span className="font-mono text-muted-foreground">{r.sweepLabel}</span>
                          </Link>
                        )}
                      </TableCell>
                    )}
                    <MeasureCell m={r.pp} />
                    <MeasureCell m={r.tg} />
                    <TableCell className="num text-right text-xs">{formatAccept(r.draftAcceptPct)}</TableCell>
                    <TableCell className="num whitespace-nowrap text-right text-xs">
                      {r.vramPeak.length === 0 ? (
                        '—'
                      ) : (
                        <Tooltip>
                          <TooltipTrigger render={<span />}>{vramTotal(r)}</TooltipTrigger>
                          <TooltipContent>
                            {r.vramPeak.map((v) => (
                              <div key={v.key}>
                                {v.name}: {formatMib(v.mib)}
                              </div>
                            ))}
                          </TooltipContent>
                        </Tooltip>
                      )}
                    </TableCell>
                    <TableCell className="num whitespace-nowrap text-right text-xs">
                      {r.durationMs === null ? '—' : formatDuration(r.durationMs)}
                    </TableCell>
                    <TableCell>
                      {r.error ? (
                        <Tooltip>
                          <TooltipTrigger render={<span />}>
                            <Badge variant={STATUS_VARIANT[r.status]}>{STATUS_LABEL[r.status]}</Badge>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-md">{r.error}</TooltipContent>
                        </Tooltip>
                      ) : (
                        <Badge variant={STATUS_VARIANT[r.status]}>{STATUS_LABEL[r.status]}</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={<Button variant="ghost" size="icon-xs" />}
                          aria-label={`Actions for run #${r.id}`}
                        >
                          <MoreHorizontal />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="min-w-48">
                          <DropdownMenuItem
                            onClick={() => {
                              useBench.getState().rerun(r);
                              // The page scrolls inside the layout, not the window: bring the form back into view.
                              document
                                .getElementById('bench-modelPath')
                                ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            }}
                          >
                            <RotateCcw /> Rerun
                          </DropdownMenuItem>
                          <DropdownMenuItem disabled={r.status === 'running'} onClick={() => void toProfile(r.id)}>
                            <UserPlus /> Create profile
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => void copyText(r.command)}>
                            <Copy /> Copy command
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            variant="destructive"
                            disabled={r.status === 'running'}
                            onClick={() => setDeleting(r)}
                          >
                            <Trash2 /> Delete
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
      </div>

      <BenchCompareDialog runs={compared} open={comparing && compared.length >= 2} onOpenChange={setComparing} />
      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete run #{deleting?.id}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its measurements will be permanently deleted from the history.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (deleting) void useBench.getState().remove(deleting.id);
                setDeleting(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </GlassCard>
  );
}

function FilterSelect(props: {
  label: string;
  value: string;
  items: { value: string; label: string }[];
  onChange(v: string): void;
  wide?: boolean;
}) {
  return (
    <Select items={props.items} value={props.value} onValueChange={(v) => v && props.onChange(v)}>
      <SelectTrigger className={props.wide ? 'w-64' : 'w-44'} aria-label={props.label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {props.items.map((i) => (
          <SelectItem key={i.value} value={i.value}>
            {i.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Throughput on one line, standard deviation below (keeps the table free of horizontal scrolling). */
function MeasureCell({ m }: { m: Measure | null }) {
  return (
    <TableCell className="num whitespace-nowrap text-right text-xs">
      {formatRate(m?.tps)}
      {m && m.stddev > 0 && <div className="text-[0.7rem] text-muted-foreground">{formatStddev(m.stddev).trim()}</div>}
    </TableCell>
  );
}
