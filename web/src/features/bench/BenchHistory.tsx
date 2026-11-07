import type { BenchRun, BenchStatus, Measure } from '@llama-webui/shared';
import { Copy, GitCompare, History, MoreHorizontal, RotateCcw, Trash2, UserPlus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { GlassCard } from '@/components/glass/GlassCard';
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { type BenchFilters, KIND_LABEL, STATUS_LABEL, useBench } from '@/lib/bench';
import { copyText } from '@/lib/clipboard';
import { formatDuration, formatRate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { BenchCompareDialog } from './BenchCompareDialog';
import { dateFmt, flagsOf, formatAccept, formatMib, modelName, vramTotal } from './format';

const MAX_COMPARE = 4;
const STATUS_VARIANT: Record<BenchStatus, 'secondary' | 'outline' | 'destructive'> = {
  queued: 'outline',
  running: 'secondary',
  ok: 'outline',
  failed: 'destructive',
  cancelled: 'secondary',
  interrupted: 'secondary',
};

/** Historique filtrable (type, modèle, statut), sélection pour la comparaison, actions par run. */
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

  // ?run=<id> (depuis Tuning) : historique avec les sweeps, ligne sélectionnée et ramenée à l'écran, puis le paramètre est retiré.
  // biome-ignore lint/correctness/useExhaustiveDependencies: déclenché par ?run, les filtres et les runs ; selected, toggle et setParams sont relus à chaque exécution sans relancer l'effet
  useEffect(() => {
    if (focus === null) return;
    if (filters.sweeps !== 'all') return setFilters({ sweeps: 'all' });
    if (!runs.some((r) => r.id === focus)) return;
    if (!selected.includes(focus)) toggle(focus);
    // Après la mise en page du formulaire (devices chargés en différé), sinon le défilement vise une position périmée.
    setTimeout(
      () => document.getElementById(`bench-run-${focus}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
      400,
    );
    setParams({}, { replace: true });
  }, [focus, filters.sweeps, runs]);

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
      title="Historique"
      icon={History}
      actions={
        <>
          <ConfirmDialog
            title="Supprimer les runs en échec ?"
            description="Les runs en échec, annulés ou interrompus seront définitivement supprimés."
            confirmLabel="Supprimer"
            destructive
            onConfirm={() => useBench.getState().removeFailed()}
            trigger={
              <Button variant="ghost" size="sm">
                <Trash2 /> Supprimer les échecs
              </Button>
            }
          />
          <Button size="sm" variant="outline" disabled={compared.length < 2} onClick={() => setComparing(true)}>
            <GitCompare /> Comparer ({compared.length})
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-3">
          <FilterSelect
            label="Outil"
            value={filters.kind}
            items={[
              { value: 'all', label: 'Tous les outils' },
              { value: 'bench', label: 'llama-bench' },
              { value: 'server', label: 'Serveur' },
            ]}
            onChange={(v) => setFilters({ kind: v as BenchFilters['kind'] })}
          />
          <FilterSelect
            label="Modèle"
            value={filters.model}
            items={[
              { value: 'all', label: 'Tous les modèles' },
              ...models.map((m) => ({ value: m, label: modelName(m) })),
            ]}
            onChange={(v) => setFilters({ model: v })}
            wide
          />
          <FilterSelect
            label="Statut"
            value={filters.status}
            items={[
              { value: 'all', label: 'Tous les statuts' },
              ...Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label })),
            ]}
            onChange={(v) => setFilters({ status: v as BenchFilters['status'] })}
          />
          <FilterSelect
            label="Sweeps"
            value={filters.sweeps}
            items={[
              { value: 'none', label: 'Sans les sweeps' },
              { value: 'all', label: 'Avec les sweeps' },
            ]}
            onChange={(v) => setFilters({ sweeps: v as BenchFilters['sweeps'] })}
          />
        </div>

        {!loaded ? (
          <Skeleton className="h-32" />
        ) : shown.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {runs.length === 0 ? 'Aucun run enregistré.' : 'Aucun run ne correspond aux filtres.'}
          </p>
        ) : (
          <Table className="[&_td]:px-1.5 [&_th]:px-1.5">
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">
                  <span className="sr-only">Sélection</span>
                </TableHead>
                <TableHead>Run</TableHead>
                <TableHead>Outil</TableHead>
                <TableHead>Modèle</TableHead>
                <TableHead>Flags</TableHead>
                {filters.sweeps === 'all' && <TableHead>Sweep</TableHead>}
                <TableHead className="text-right">Prompt</TableHead>
                <TableHead className="text-right">Génération</TableHead>
                <TableHead className="text-right">MTP</TableHead>
                <TableHead className="text-right">VRAM pic</TableHead>
                <TableHead className="text-right">Durée</TableHead>
                <TableHead>Statut</TableHead>
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
                        aria-label={`Sélectionner le run #${r.id} pour la comparaison`}
                      />
                    </TableCell>
                    <TableCell className="num whitespace-nowrap text-xs">
                      #{r.id}
                      <div className="text-[0.7rem] text-muted-foreground">{dateFmt.format(r.createdAt)}</div>
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
                                {v.name} : {formatMib(v.mib)}
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
                          aria-label={`Actions pour le run #${r.id}`}
                        >
                          <MoreHorizontal />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="min-w-48">
                          <DropdownMenuItem
                            onClick={() => {
                              useBench.getState().rerun(r);
                              // La page défile dans le layout, pas dans window : on ramène le formulaire à l'écran.
                              document
                                .getElementById('bench-modelPath')
                                ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            }}
                          >
                            <RotateCcw /> Relancer
                          </DropdownMenuItem>
                          <DropdownMenuItem disabled={r.status === 'running'} onClick={() => void toProfile(r.id)}>
                            <UserPlus /> Créer un profil
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => void copyText(r.command)}>
                            <Copy /> Copier la commande
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            variant="destructive"
                            disabled={r.status === 'running'}
                            onClick={() => setDeleting(r)}
                          >
                            <Trash2 /> Supprimer
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
            <AlertDialogTitle>Supprimer le run #{deleting?.id} ?</AlertDialogTitle>
            <AlertDialogDescription>
              Ses mesures seront définitivement supprimées de l'historique.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (deleting) void useBench.getState().remove(deleting.id);
                setDeleting(null);
              }}
            >
              Supprimer
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

/** Débit sur une ligne, écart-type en dessous (le tableau tient sans défilement horizontal). */
function MeasureCell({ m }: { m: Measure | null }) {
  return (
    <TableCell className="num whitespace-nowrap text-right text-xs">
      {formatRate(m?.tps)}
      {m && m.stddev > 0 && (
        <div className="text-[0.7rem] text-muted-foreground">
          ± {new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 }).format(m.stddev)}
        </div>
      )}
    </TableCell>
  );
}
