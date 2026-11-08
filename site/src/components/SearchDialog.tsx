import { FileText, Hash } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';

/** The parts of Pagefind's browser API used here (dist/pagefind/pagefind.js, written by scripts/postbuild.ts). */
interface Pagefind {
  options(o: { baseUrl: string }): Promise<void>;
  debouncedSearch(
    query: string,
    options?: object,
    ms?: number,
  ): Promise<{ results: { data(): Promise<Result> }[] } | null>;
}

interface Result {
  url: string;
  meta: { title?: string };
  excerpt: string;
  sub_results?: { title: string; url: string; excerpt: string }[];
}

interface Hit {
  url: string;
  title: string;
  page: string;
  excerpt: string;
  heading: boolean;
}

const BASE = import.meta.env.BASE_URL;
let loading: Promise<Pagefind> | null = null;

/** Loads the index script on first use only (never while prerendering). */
function loadPagefind(): Promise<Pagefind> {
  loading ??= import(/* @vite-ignore */ `${BASE}pagefind/pagefind.js`).then(async (pf: Pagefind) => {
    await pf.options({ baseUrl: BASE });
    return pf;
  });
  return loading;
}

/** Pagefind excerpts mark the matches with <mark>: rebuilt as React nodes, without injecting HTML. */
function Excerpt({ html }: { html: string }) {
  const nodes = [...new DOMParser().parseFromString(html, 'text/html').body.childNodes];
  return (
    <>
      {nodes.map((n, i) =>
        n.nodeName === 'MARK' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: static fragments of one excerpt
          <mark key={i} className="rounded-sm bg-primary/20 px-0.5 text-foreground">
            {n.textContent}
          </mark>
        ) : (
          n.textContent
        ),
      )}
    </>
  );
}

/** ⌘K search over the documentation, powered by the Pagefind index of the built site. */
export function SearchDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef('');

  useEffect(() => {
    latest.current = query;
    if (!query.trim()) {
      setHits([]);
      return;
    }
    loadPagefind()
      .then(async (pf) => {
        const search = await pf.debouncedSearch(query, {}, 150);
        if (!search || latest.current !== query) return;
        const data = await Promise.all(search.results.slice(0, 8).map((r) => r.data()));
        if (latest.current !== query) return;
        setError(null);
        setHits(
          data.flatMap((d) => {
            const page = d.meta.title ?? d.url;
            const subs = (d.sub_results ?? []).filter((s) => s.url !== d.url).slice(0, 3);
            return [
              { url: d.url, title: page, page, excerpt: d.excerpt, heading: false },
              ...subs.map((s) => ({ url: s.url, title: s.title, page, excerpt: s.excerpt, heading: true })),
            ];
          }),
        );
      })
      .catch(() =>
        setError(
          import.meta.env.DEV
            ? 'No search index in dev: run `bun run site:build`, then `bun run site:preview`.'
            : 'Search is unavailable.',
        ),
      );
  }, [query]);

  const go = (url: string) => {
    onOpenChange(false);
    setQuery('');
    navigate(url.startsWith(BASE) ? `/${url.slice(BASE.length)}` : url);
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Search the documentation"
      description="Type to search every page of the documentation."
    >
      <Command shouldFilter={false}>
        <CommandInput value={query} onValueChange={setQuery} placeholder="Search the documentation…" />
        <CommandList className="max-h-[min(28rem,60dvh)]">
          {error ? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">{error}</p>
          ) : (
            query.trim() && <CommandEmpty>No results for “{query}”.</CommandEmpty>
          )}
          {hits.length > 0 && (
            <CommandGroup>
              {hits.map((h) => (
                <CommandItem key={h.url} value={h.url} onSelect={() => go(h.url)} className="items-start gap-3 py-2">
                  {h.heading ? (
                    <Hash className="mt-0.5 ml-4 size-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  )}
                  <div className="min-w-0">
                    <p className="truncate font-medium">
                      {h.title}
                      {h.heading && <span className="font-normal text-muted-foreground"> in {h.page}</span>}
                    </p>
                    <p className="line-clamp-2 text-xs text-muted-foreground">
                      <Excerpt html={h.excerpt} />
                    </p>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
