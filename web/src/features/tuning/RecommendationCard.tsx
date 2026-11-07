import type { BenchParams, Estimate } from '@llama-webui/shared';
import { Gauge, Lock, Pencil, TriangleAlert, UserPlus, Wand2, X } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { GlassCard } from '@/components/glass/GlassCard';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatBps, formatBytes } from '@/lib/format';
import { useTuning } from '@/lib/tuning';
import {
  benchFromEstimate,
  PIN_LABEL,
  PIN_OF_ROW,
  type PinKey,
  parsePin,
  pinValue,
  profileFromEstimate,
} from './actions';
import { MemoryBars } from './MemoryBars';

/** Débit de génération pris pour chiffrer la lecture disque d'un modèle qui déborde. */
const REF_TPS = 10;

/** La configuration recommandée, flag par flag, avec ses budgets mémoire ; chaque valeur peut être imposée. */
export function RecommendationCard() {
  const modelPath = useTuning((s) => s.modelPath);
  const estimate = useTuning((s) => s.estimate);
  const estimating = useTuning((s) => s.estimating);
  const error = useTuning((s) => s.estimateError);
  const pinned = useTuning((s) => s.pinned);
  const hw = useTuning((s) => s.hardware);
  const diskSpeed = useTuning((s) => s.diskSpeed);
  const navigate = useNavigate();
  const names = Object.fromEntries((hw?.devices ?? []).map((d) => [d.id, d.name]));
  const pins = Object.entries(pinned) as [keyof BenchParams, unknown][];

  return (
    <GlassCard
      title="Recommandation (estimation)"
      icon={Wand2}
      actions={
        estimate?.ok && (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                benchFromEstimate(estimate);
                navigate('/bench');
              }}
            >
              <Gauge /> Lancer un bench
            </Button>
            <Button
              size="sm"
              onClick={async () => {
                const p = await profileFromEstimate(estimate);
                if (p) navigate(`/profiles?id=${p.id}`);
              }}
            >
              <UserPlus /> Créer un profil
            </Button>
          </>
        )
      }
    >
      {!modelPath ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          Choisissez un modèle ou un profil : la recommandation s'affiche ici.
        </p>
      ) : error ? (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>Estimation impossible</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : !estimate ? (
        <Skeleton className="h-72" />
      ) : (
        <div className="flex flex-col gap-5" aria-busy={estimating}>
          {pins.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground">Imposé :</span>
              {pins.map(([k, v]) => (
                <Badge key={k} variant="secondary" className="gap-1 pr-0.5 font-mono">
                  {PIN_LABEL[k]} {pinValue(v)}
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="size-4"
                    onClick={() => useTuning.getState().unpin(k)}
                    aria-label={`Ne plus imposer ${PIN_LABEL[k]}`}
                  >
                    <X />
                  </Button>
                </Badge>
              ))}
            </div>
          )}
          {!estimate.ok && (
            <Alert variant="destructive">
              <TriangleAlert />
              <AlertTitle>Ne tient pas</AlertTitle>
              <AlertDescription>{estimate.reason}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            {estimate.ok ? (
              <RowsTable estimate={estimate} pinned={pinned} />
            ) : (
              <code className="self-start rounded-md bg-well inset-shadow-well p-3 font-mono text-xs break-all">
                {estimate.serverArgs.join(' ')}
              </code>
            )}
            <div className="flex flex-col gap-4">
              <MemoryBars fit={estimate.fit} names={names} ramTotalBytes={hw?.ramTotalBytes ?? 0} />
              {estimate.ramOverflowBytes > 0 && (
                <p className="text-sm text-muted-foreground">
                  Débordement de <span className="num text-foreground">{formatBytes(estimate.ramOverflowBytes)}</span> :
                  à {REF_TPS} t/s, lecture NVMe ≈{' '}
                  <span className="num text-foreground">{formatBps(estimate.diskReadBytesPerToken * REF_TPS)}</span>
                  {diskSpeed && diskSpeed.path === modelPath ? (
                    <>
                      {' '}
                      (mesuré : <span className="num text-foreground">{formatBps(diskSpeed.bytesPerSec)}</span>)
                    </>
                  ) : (
                    ' (débit du disque : page Système, « Mesurer le disque »)'
                  )}
                  .
                </p>
              )}
            </div>
          </div>
          {estimate.warnings.length > 0 && (
            <ul className="flex flex-col gap-1.5">
              {estimate.warnings.map((w) => (
                <li key={w} className="flex items-start gap-2 text-sm">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-label="Attention" />
                  {w}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </GlassCard>
  );
}

function RowsTable({ estimate, pinned }: { estimate: Estimate; pinned: Partial<BenchParams> }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Flag</TableHead>
          <TableHead>Valeur</TableHead>
          <TableHead>Pourquoi</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {estimate.rows.map((r) => {
          const key = PIN_OF_ROW[r.flag];
          const isPinned = key !== undefined && pinKeys(key).some((k) => k in pinned);
          return (
            <TableRow key={r.flag}>
              <TableCell className="font-mono text-xs whitespace-nowrap">{r.flag}</TableCell>
              <TableCell className="font-mono text-xs">
                <span className="flex items-center gap-1">
                  {r.value || '—'}
                  {isPinned && <Lock className="size-3 text-muted-foreground" aria-label="imposé" />}
                  {key && <PinEditor pin={key} flag={r.flag} initial={r.value.split(' / ').at(-1) ?? r.value} />}
                </span>
              </TableCell>
              <TableCell className="text-xs whitespace-normal text-muted-foreground">{r.why}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

const pinKeys = (k: PinKey): (keyof BenchParams)[] => (k === 'kv' ? ['ctk', 'ctv'] : [k]);

function PinEditor({ pin, flag, initial }: { pin: PinKey; flag: string; initial: string }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    const patch = parsePin(pin, text);
    if (typeof patch === 'string') return setError(patch);
    useTuning.getState().pin(patch);
    setOpen(false);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) {
          setText(initial);
          setError(null);
        }
      }}
    >
      <PopoverTrigger render={<Button variant="ghost" size="icon-xs" aria-label={`Imposer ${flag}`} />}>
        <Pencil />
      </PopoverTrigger>
      <PopoverContent className="w-64">
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <span className="text-sm font-medium">
            Imposer <span className="font-mono">{pin === 'ub' ? '-ub' : flag}</span>
          </span>
          <Input
            autoFocus
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setError(null);
            }}
            className="font-mono"
            aria-invalid={error ? true : undefined}
          />
          {error && <span className="text-xs text-destructive">{error}</span>}
          <span className="text-xs text-muted-foreground">
            L'estimateur cherche le meilleur placement avec cette valeur.
          </span>
          <Button type="submit" size="sm">
            Imposer
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}
