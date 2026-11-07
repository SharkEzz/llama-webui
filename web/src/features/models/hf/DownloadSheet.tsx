import { type HfSearchHit, type HfStatus, parseHfInput } from '@llama-webui/shared';
import { Download, Heart, KeyRound, Lock, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { getHfStatus, searchHf } from '@/lib/downloads';
import { fmt, formatInt } from '@/lib/format';
import { QueueList } from './QueueList';
import { RepoView } from './RepoView';

const DEFAULT_ENDPOINT = 'https://huggingface.co';
const SEARCH_DEBOUNCE_MS = 300;

/** Compact count: “1.2M”, “45.3k”, “812”. */
const compact = (n: number) => (n >= 1e6 ? `${fmt(n / 1e6, 1)}M` : n >= 1e3 ? `${fmt(n / 1e3, 1)}k` : formatInt(n));

function TokenLine({ status }: { status: HfStatus | null }) {
  if (!status) return <span>Checking the Hugging Face token…</span>;
  if (!status.token)
    return (
      <span>
        No token: public models only. Set <code>HF_TOKEN</code> or run <code>hf auth login</code> for gated repos.
      </span>
    );
  if (status.tokenInvalid)
    return (
      <span className="text-destructive">
        The token from {status.token === 'env' ? <code>HF_TOKEN</code> : <code>hf auth login</code>} was rejected.
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1">
      <KeyRound className="size-3" />
      {status.user ? (
        <>
          Signed in as <span className="font-medium text-foreground">{status.user}</span>
        </>
      ) : (
        'Token found'
      )}{' '}
      ({status.token === 'env' ? <code>HF_TOKEN</code> : <code>hf auth login</code>})
    </span>
  );
}

function SearchResults({ q, onPick }: { q: string; onPick(id: string): void }) {
  const [hits, setHits] = useState<HfSearchHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    const t = setTimeout(() => {
      searchHf(q, ac.signal).then(
        (h) => {
          setHits(h);
          setError(null);
        },
        (e: unknown) => !ac.signal.aborted && setError(e instanceof Error ? e.message : String(e)),
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [q]);

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!hits) return <Skeleton className="h-40" />;
  if (hits.length === 0) return <p className="text-sm text-muted-foreground">No GGUF repository matches “{q}”.</p>;
  return (
    <ul className="flex flex-col">
      {hits.map((h) => (
        <li key={h.id}>
          <button
            type="button"
            className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-muted/50"
            onClick={() => onPick(h.id)}
          >
            <span className="min-w-0 flex-1 truncate text-sm">{h.id}</span>
            {h.gated && <Lock className="size-3 text-muted-foreground" aria-label="Gated" />}
            <span className="num inline-flex items-center gap-1 text-xs text-muted-foreground" title="Downloads">
              <Download className="size-3" />
              {compact(h.downloads)}
            </span>
            <span className="num inline-flex items-center gap-1 text-xs text-muted-foreground" title="Likes">
              <Heart className="size-3" />
              {compact(h.likes)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Side panel of the Models page: search Hugging Face (or paste a repo), pick a GGUF, follow the queue. */
export function DownloadSheet({
  open,
  onOpenChange,
  onShow,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  onShow(path: string): void;
}) {
  const [input, setInput] = useState('');
  /** Repo picked from the search results (a pasted repo id or URL is used directly). */
  const [picked, setPicked] = useState<string | null>(null);
  const [status, setStatus] = useState<HfStatus | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    getHfStatus().then(
      (s) => live && setStatus(s),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [open]);

  const endpoint = status?.endpoint ?? DEFAULT_ENDPOINT;
  const parsed = parseHfInput(input);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 data-[side=right]:sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Download from Hugging Face</SheetTitle>
          <SheetDescription>
            <TokenLine status={status} />
          </SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-3">
          <InputGroup>
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <InputGroupInput
              autoFocus
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                setPicked(null);
              }}
              placeholder="Search GGUF models, or paste org/repo or a URL"
            />
          </InputGroup>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-5 px-4 pb-4">
            {parsed.kind === 'repo' ? (
              <RepoView key={parsed.repo} id={parsed.repo} hint={parsed} endpoint={endpoint} />
            ) : picked ? (
              <RepoView
                key={picked}
                id={picked}
                hint={{ file: null, quant: null }}
                endpoint={endpoint}
                onBack={() => setPicked(null)}
              />
            ) : parsed.kind === 'query' ? (
              <SearchResults q={parsed.q} onPick={setPicked} />
            ) : (
              <p className="text-sm text-muted-foreground">
                Files go to <code>&lt;models folder&gt;/&lt;org&gt;/&lt;repo&gt;/</code>, one download at a time; an
                interrupted download resumes where it stopped.
              </p>
            )}
            <QueueList endpoint={endpoint} onShow={onShow} />
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
