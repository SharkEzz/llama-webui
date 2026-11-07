import { type DownloadItem, type DownloadLive, isDownloadActive } from '@llama-webui/shared';
import { Check, ExternalLink, RotateCcw, Trash2, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { downloadPath, useDownloads } from '@/lib/downloads';
import { formatBps, formatBytes, formatDuration, formatPct } from '@/lib/format';
import { useNow } from '@/lib/useNow';

const MAX_FINISHED = 20;

/** The download queue: running and queued items first, then the last finished ones. */
export function QueueList({ endpoint, onShow }: { endpoint: string; onShow(path: string): void }) {
  const { items, live, clearFinished } = useDownloads();
  const active = items.filter((i) => isDownloadActive(i.status));
  const finished = items
    .filter((i) => !isDownloadActive(i.status))
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
    .slice(0, MAX_FINISHED);
  if (items.length === 0) return null;
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Downloads</h3>
        {finished.length > 0 && (
          <Button size="xs" variant="ghost" onClick={() => void clearFinished()}>
            Clear finished
          </Button>
        )}
      </div>
      <ul className="flex flex-col gap-2">
        {[...active, ...finished].map((i) => (
          <QueueRow key={i.id} item={i} live={live?.id === i.id ? live : null} endpoint={endpoint} onShow={onShow} />
        ))}
      </ul>
    </section>
  );
}

function QueueRow({
  item,
  live,
  endpoint,
  onShow,
}: {
  item: DownloadItem;
  live: DownloadLive | null;
  endpoint: string;
  onShow(path: string): void;
}) {
  const { cancel, retry, remove } = useDownloads();
  const active = isDownloadActive(item.status);
  return (
    <li className="flex flex-col gap-1.5 rounded-lg border border-border/60 bg-background/40 p-2.5">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {item.quant && <Badge variant="secondary">{item.quant}</Badge>}
            {item.kind === 'mmproj' && <Badge variant="outline">mmproj</Badge>}
            <span className="truncate font-mono text-xs" title={item.name}>
              {item.name}
            </span>
          </div>
          <div className="truncate text-xs text-muted-foreground">{item.repo}</div>
        </div>
        {active ? (
          <Button size="icon-xs" variant="ghost" aria-label="Cancel the download" onClick={() => void cancel(item.id)}>
            <X />
          </Button>
        ) : (
          <div className="flex gap-1">
            {item.status === 'done' && (
              <Button size="xs" variant="ghost" onClick={() => onShow(downloadPath(item))}>
                Details
              </Button>
            )}
            {(item.status === 'error' || item.status === 'canceled') && (
              <Button size="icon-xs" variant="ghost" aria-label="Retry" onClick={() => void retry(item.id)}>
                <RotateCcw />
              </Button>
            )}
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Remove from the list"
              onClick={() => void remove(item.id)}
            >
              <Trash2 />
            </Button>
          </div>
        )}
      </div>
      <RowStatus item={item} live={live} endpoint={endpoint} />
    </li>
  );
}

function RowStatus({ item, live, endpoint }: { item: DownloadItem; live: DownloadLive | null; endpoint: string }) {
  const total = formatBytes(item.totalBytes);
  switch (item.status) {
    case 'queued':
      return <p className="text-xs text-muted-foreground">Queued · {total}</p>;
    case 'downloading':
      return <Running item={item} live={live} />;
    case 'done':
      return (
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          <Check className="size-3" /> Downloaded · {total}
        </p>
      );
    case 'canceled':
      return <p className="text-xs text-muted-foreground">Canceled</p>;
    case 'error':
      return (
        <div className="flex flex-col gap-0.5 text-xs">
          <p className="text-destructive">{item.error ?? 'Failed'}</p>
          {item.code === 'hf-gated' && (
            <a
              className="inline-flex w-fit items-center gap-1 underline underline-offset-2"
              href={`${endpoint}/${item.repo}`}
              target="_blank"
              rel="noreferrer"
            >
              Accept the license on Hugging Face <ExternalLink className="size-3" />
            </a>
          )}
        </div>
      );
  }
}

function Running({ item, live }: { item: DownloadItem; live: DownloadLive | null }) {
  const now = useNow(1000);
  const done = live?.bytesDone ?? item.bytesDone;
  const pct = item.totalBytes > 0 ? (done / item.totalBytes) * 100 : 0;
  const parts = item.files.length > 1 && live ? item.files.findIndex((f) => f.path === live.file) + 1 : 0;
  let detail: string;
  if (live?.phase === 'verifying') detail = 'Checking the partial file…';
  else if (live?.phase === 'retrying')
    detail = `Connection lost, retrying in ${formatDuration(Math.max(0, (live.retryAt ?? now) - now))}`;
  else {
    const bps = live?.bps ?? 0;
    const eta = bps > 0 ? ` · ${formatDuration(((item.totalBytes - done) / bps) * 1000)} left` : '';
    detail = `${formatBytes(done)} of ${formatBytes(item.totalBytes)} · ${formatBps(bps)}${eta}`;
  }
  return (
    <div className="flex flex-col gap-1">
      <Progress value={pct} />
      <p className="num flex justify-between gap-2 text-xs text-muted-foreground">
        <span className="truncate">{detail}</span>
        <span>
          {parts > 0 && `part ${parts}/${item.files.length} · `}
          {formatPct(pct)}
        </span>
      </p>
    </div>
  );
}
