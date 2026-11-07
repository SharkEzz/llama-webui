import { type BenchParams, type BenchRun, benchArgs, serverArgs } from '@llama-webui/shared';
import { TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { KIND_LABEL } from '@/lib/bench';
import { formatShortDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { BenchBars } from './BenchBars';
import { formatAccept, formatMeasure, formatMib, modelName } from './format';

const PARAM_ROWS: { key: keyof BenchParams; label: string }[] = [
  { key: 'ngl', label: '-ngl' },
  { key: 'ncmoe', label: '-ncmoe' },
  { key: 'dev', label: '-dev' },
  { key: 'ts', label: '-ts' },
  { key: 'sm', label: '-sm' },
  { key: 'fa', label: '-fa' },
  { key: 'ctk', label: '-ctk' },
  { key: 'ctv', label: '-ctv' },
  { key: 'ot', label: '-ot' },
  { key: 't', label: '-t' },
  { key: 'b', label: '-b' },
  { key: 'ub', label: '-ub' },
];

/** A flag's value in the run's tool syntax (“default” when absent). */
function paramText(run: BenchRun, key: keyof BenchParams): string {
  const one = { [key]: run.spec.params[key] } as BenchParams;
  const args = run.kind === 'bench' ? benchArgs(one) : serverArgs(one);
  return args[1] ?? 'default';
}

/** Side-by-side comparison of 2 to 4 runs: flags (differences highlighted), throughput, VRAM, hardware, then pp/tg bars. */
export function BenchCompareDialog({
  runs,
  open,
  onOpenChange,
}: {
  runs: BenchRun[];
  open: boolean;
  onOpenChange(o: boolean): void;
}) {
  const mixed = new Set(runs.map((r) => r.kind)).size > 1;
  const hw = (r: BenchRun) => JSON.stringify({ cpu: r.hardware.cpu, gpus: r.hardware.gpus.map((g) => g.name) });
  const otherHardware = new Set(runs.map(hw)).size > 1;
  const gpuKeys = [...new Map(runs.flatMap((r) => r.vramPeak.map((v) => [v.key, v.name] as const))).entries()];

  const row = (label: ReactNode, values: string[], highlight = true) => {
    const differs = highlight && new Set(values).size > 1;
    return (
      <TableRow key={String(label)}>
        <TableHead className="font-mono text-xs">{label}</TableHead>
        {values.map((v, i) => (
          <TableCell
            key={runs[i]!.id}
            className={cn(
              'max-w-56 truncate font-mono text-xs',
              differs && 'bg-accent font-medium text-accent-foreground',
            )}
            title={v}
          >
            {v}
          </TableCell>
        ))}
      </TableRow>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>Comparing {runs.length} runs</DialogTitle>
          <DialogDescription>Values that differ between runs are highlighted.</DialogDescription>
        </DialogHeader>
        {mixed && (
          <Alert>
            <TriangleAlert />
            <AlertDescription>
              llama-bench and server runs are not directly comparable: llama-bench does not measure speculative decoding
              (MTP, draft) or the profile’s context.
            </AlertDescription>
          </Alert>
        )}
        {otherHardware && (
          <Alert>
            <TriangleAlert />
            <AlertDescription>These runs used different hardware (CPU or GPU).</AlertDescription>
          </Alert>
        )}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead />
              {runs.map((r) => (
                <TableHead key={r.id} className="num">
                  #{r.id} · {formatShortDate(r.createdAt)}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {row(
              'Tool',
              runs.map((r) => KIND_LABEL[r.kind]),
            )}
            {row(
              'Model',
              runs.map((r) => modelName(r.spec.modelPath)),
            )}
            {PARAM_ROWS.map((p) =>
              row(
                p.label,
                runs.map((r) => paramText(r, p.key)),
              ),
            )}
            {row(
              'Other flags',
              runs.map((r) => (r.kind === 'server' ? r.spec.serverArgs.join(' ') || '—' : 'ignored')),
            )}
            {row(
              '-p / -n / -r',
              runs.map((r) => `${r.spec.p} / ${r.spec.n} / ${r.spec.r}`),
            )}
            {row(
              'Prompt',
              runs.map((r) => formatMeasure(r.pp)),
              false,
            )}
            {row(
              'Generation',
              runs.map((r) => formatMeasure(r.tg)),
              false,
            )}
            {row(
              'MTP accepted',
              runs.map((r) => formatAccept(r.draftAcceptPct)),
              false,
            )}
            {gpuKeys.map(([key, name]) =>
              row(
                `VRAM ${name}`,
                runs.map((r) => {
                  const v = r.vramPeak.find((x) => x.key === key);
                  return v ? formatMib(v.mib) : '—';
                }),
                false,
              ),
            )}
            {row(
              'Build',
              runs.map((r) => r.hardware.build ?? '—'),
            )}
            {row(
              'CPU',
              runs.map((r) => r.hardware.cpu || '—'),
            )}
          </TableBody>
        </Table>
        <BenchBars runs={runs} />
      </DialogContent>
    </Dialog>
  );
}
