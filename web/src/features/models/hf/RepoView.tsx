import { type HfRepo, type HfVariant, isDownloadActive, type VramFit, vramFit } from '@llama-webui/shared';
import { ArrowLeft, Check, Download, ExternalLink, Lock } from 'lucide-react';
import { useEffect, useState } from 'react';
import { TONE_VAR, type Tone } from '@/components/glass/tones';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/lib/api';
import { getHfRepo, useDownloads } from '@/lib/downloads';
import { formatBytes } from '@/lib/format';
import { useMonitor } from '@/lib/monitor';
import { cn } from '@/lib/utils';

const FIT: Record<VramFit, { label: string; tone: Tone; title: string }> = {
  fits: { label: 'Fits in VRAM', tone: 'teal', title: 'The weights take at most 85% of the VRAM' },
  tight: {
    label: 'Tight',
    tone: 'amber',
    title: 'The weights take 85–100% of the VRAM: little room left for the context',
  },
  offload: { label: 'Partial offload', tone: 'rose', title: 'Larger than the VRAM: part of the model stays in RAM' },
};

function FitBadge({ fit }: { fit: VramFit }) {
  const f = FIT[fit];
  return (
    <Badge
      variant="outline"
      title={f.title}
      style={{ color: TONE_VAR[f.tone], borderColor: `color-mix(in oklab, ${TONE_VAR[f.tone]} 40%, transparent)` }}
    >
      {f.label}
    </Badge>
  );
}

/** Projector suggested with a model: F16, else BF16, else the smallest. */
const preferredProjector = (ps: HfVariant[]) =>
  ps.find((p) => p.quant === 'F16') ?? ps.find((p) => p.quant === 'BF16') ?? ps[0] ?? null;

/** Total VRAM of the visible GPUs (0 without a GPU or before the first snapshot). */
function useVramBytes(): number {
  const gpus = useMonitor((s) => s.snapshot?.allGpus);
  return (gpus ?? []).filter((g) => !g.hidden).reduce((a, g) => a + g.vramTotalBytes, 0);
}

export interface RepoHint {
  file: string | null;
  quant: string | null;
}

/** A repository's GGUF variants, with what is on disk or queued; mount with `key={id}`. */
export function RepoView({
  id,
  hint,
  endpoint,
  onBack,
}: {
  id: string;
  hint: RepoHint;
  endpoint: string;
  onBack?: () => void;
}) {
  const [repo, setRepo] = useState<HfRepo | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [withProjector, setWithProjector] = useState(true);
  const [busy, setBusy] = useState(false);
  const items = useDownloads((s) => s.items);
  const enqueue = useDownloads((s) => s.enqueue);
  const vram = useVramBytes();
  // A download of this repo that finishes changes what is on disk: list again.
  const doneHere = items.filter((i) => i.repo === id && i.status === 'done').length;

  // biome-ignore lint/correctness/useExhaustiveDependencies: doneHere is a trigger (reload when a download of this repo finishes)
  useEffect(() => {
    const ac = new AbortController();
    getHfRepo(id, ac.signal).then(
      (r) => {
        setRepo(r);
        setError(null);
      },
      (e: unknown) => {
        if (!ac.signal.aborted) setError(e instanceof ApiError ? e : new ApiError(0, String(e)));
      },
    );
    return () => ac.abort();
  }, [id, doneHere]);

  const queued = new Set(items.filter((i) => i.repo === id && isDownloadActive(i.status)).map((i) => i.key));
  const back = onBack && (
    <Button size="xs" variant="ghost" className="w-fit" onClick={onBack}>
      <ArrowLeft /> Results
    </Button>
  );

  if (error)
    return (
      <div className="flex flex-col gap-2">
        {back}
        <Alert variant="destructive">
          <AlertTitle>{id}</AlertTitle>
          <AlertDescription>
            <p>{error.message}</p>
            {error.code === 'hf-gated' && (
              <a
                className="inline-flex items-center gap-1 underline underline-offset-2"
                href={`${endpoint}/${id}`}
                target="_blank"
                rel="noreferrer"
              >
                Open the repository <ExternalLink className="size-3" />
              </a>
            )}
          </AlertDescription>
        </Alert>
      </div>
    );
  if (!repo)
    return (
      <div className="flex flex-col gap-2">
        {back}
        <Skeleton className="h-48" />
      </div>
    );

  const projector = preferredProjector(repo.projectors);
  const offerProjector =
    projector !== null && !repo.projectors.some((p) => p.present === 'complete' || queued.has(p.key));
  const download = async (v: HfVariant) => {
    const keys = [v.key];
    if (v.kind === 'model' && offerProjector && withProjector && projector) keys.push(projector.key);
    setBusy(true);
    await enqueue(repo.id, repo.sha, keys);
    setBusy(false);
  };
  const highlighted = (v: HfVariant) =>
    (hint.file !== null && v.files.some((f) => f.path === hint.file)) ||
    (hint.quant !== null && v.quant?.toLowerCase() === hint.quant.toLowerCase());

  const row = (v: HfVariant) => (
    <VariantRow
      key={v.key}
      v={v}
      queued={queued.has(v.key)}
      fit={v.kind === 'model' ? vramFit(v.totalBytes, vram) : null}
      highlight={highlighted(v)}
      busy={busy}
      onDownload={() => void download(v)}
    />
  );

  return (
    <div className="flex flex-col gap-3">
      {back}
      <div className="flex flex-col gap-0.5">
        <a
          className="inline-flex w-fit items-center gap-1 font-medium underline-offset-2 hover:underline"
          href={repo.url}
          target="_blank"
          rel="noreferrer"
        >
          {repo.id} <ExternalLink className="size-3" />
        </a>
        <p className="truncate font-mono text-xs text-muted-foreground" title={repo.dir}>
          → {repo.dir}
        </p>
      </div>
      {repo.gated && (
        <Alert>
          <Lock />
          <AlertDescription>
            Gated repository: accept its license on{' '}
            <a className="underline underline-offset-2" href={repo.url} target="_blank" rel="noreferrer">
              Hugging Face
            </a>{' '}
            with the account of your token first.
          </AlertDescription>
        </Alert>
      )}
      {repo.variants.length === 0 && repo.projectors.length === 0 ? (
        <p className="text-sm text-muted-foreground">No GGUF file in this repository.</p>
      ) : (
        <>
          {offerProjector && projector && repo.variants.length > 0 && (
            <div className="flex items-center gap-2">
              <Checkbox
                id="hf-with-projector"
                checked={withProjector}
                onCheckedChange={(v) => setWithProjector(v === true)}
              />
              <Label htmlFor="hf-with-projector" className="font-normal">
                Also download the projector ({projector.quant ?? projector.name}, {formatBytes(projector.totalBytes)})
                for image input
              </Label>
            </div>
          )}
          <div className="flex flex-col gap-1">{repo.variants.map(row)}</div>
          {repo.projectors.length > 0 && (
            <div className="flex flex-col gap-1">
              <h4 className="text-xs font-medium text-muted-foreground">Projectors (mmproj)</h4>
              {repo.projectors.map(row)}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function VariantRow({
  v,
  queued,
  fit,
  highlight,
  busy,
  onDownload,
}: {
  v: HfVariant;
  queued: boolean;
  fit: VramFit | null;
  highlight: boolean;
  busy: boolean;
  onDownload(): void;
}) {
  return (
    <div
      className={cn('flex items-center gap-3 rounded-md px-2 py-1.5', highlight ? 'bg-accent' : 'hover:bg-muted/50')}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Badge variant="secondary">{v.quant ?? '—'}</Badge>
          <span className="truncate font-mono text-xs" title={v.key}>
            {v.name}
          </span>
        </div>
        <div className="num text-xs text-muted-foreground">
          {formatBytes(v.totalBytes)}
          {v.files.length > 1 && ` · ${v.files.length} parts`}
        </div>
      </div>
      {fit && <FitBadge fit={fit} />}
      {v.present === 'complete' ? (
        <Badge variant="outline">
          <Check /> Downloaded
        </Badge>
      ) : queued ? (
        <Badge variant="outline">Queued</Badge>
      ) : (
        <Button size="sm" variant="secondary" disabled={busy} onClick={onDownload}>
          <Download /> {v.present === 'partial' ? 'Resume' : 'Download'}
        </Button>
      )}
    </div>
  );
}
