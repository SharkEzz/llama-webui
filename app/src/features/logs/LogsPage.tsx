import { filterLogs, type LogLevel } from '@llama-webui/shared';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDownToLine, Copy, Eraser, ScrollText, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { GLASS } from '@/components/glass/glass';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/Select';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { copyText } from '@/lib/clipboard';
import { formatInt, plural } from '@/lib/format';
import { hideCurrentLogs, useLogs } from '@/lib/logs';
import { cn } from '@/lib/utils';
import { LogRow } from './LogRow';

const LEVELS: { value: LogLevel; label: string }[] = [
  { value: 'debug', label: 'Debug and above' },
  { value: 'info', label: 'Info and above' },
  { value: 'warn', label: 'Warnings and errors' },
  { value: 'error', label: 'Errors only' },
];

const BOTTOM_SLACK_PX = 40;

const EMPTY = {
  none: { title: 'No logs', description: 'Start llama-server from the Server page.' },
  cleared: { title: 'View cleared', description: 'New lines will appear here.' },
  filtered: { title: 'No lines match the filters', description: 'Lower the minimum level or change the search.' },
} as const;

export function LogsPage() {
  const all = useLogs((s) => s.lines);
  const hiddenBefore = useLogs((s) => s.hiddenBefore);
  const [minLevel, setMinLevel] = useState<LogLevel>('debug');
  const [query, setQuery] = useState('');
  const [follow, setFollow] = useState(true);
  const scroller = useRef<HTMLElement>(null);
  const userScroll = useRef(false);

  const lines = useMemo(
    () =>
      filterLogs(hiddenBefore < 0 ? all : all.filter((l) => l.seq >= hiddenBefore), { minLevel, query: query.trim() }),
    [all, minLevel, query, hiddenBefore],
  );

  const visible = hiddenBefore < 0 ? all.length : all.filter((l) => l.seq >= hiddenBefore).length;
  const empty: keyof typeof EMPTY = all.length === 0 ? 'none' : visible === 0 ? 'cleared' : 'filtered';

  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 20,
    overscan: 20,
    getItemKey: (i) => lines[i]!.seq,
  });

  useEffect(() => {
    if (follow && lines.length > 0) virtualizer.scrollToIndex(lines.length - 1, { align: 'end' });
  }, [follow, lines.length, virtualizer]);

  return (
    <div className="flex h-[calc(100dvh-5.5rem)] min-h-96 flex-col gap-4">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-3xl font-semibold tracking-tight">Logs</h1>
        <span className="text-sm text-muted-foreground">
          <span className="num text-foreground/80">{formatInt(lines.length)}</span> {plural(lines.length, 'line')}
          {lines.length !== all.length && (
            <>
              {' '}
              of <span className="num">{formatInt(all.length)}</span>
            </>
          )}
        </span>
      </header>

      <div className={cn(GLASS, 'flex flex-wrap items-center gap-3 p-3')}>
        <Select items={LEVELS} value={minLevel} onValueChange={(v) => v && setMinLevel(v as LogLevel)}>
          <SelectTrigger className="w-56" aria-label="Minimum level">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LEVELS.map((l) => (
              <SelectItem key={l.value} value={l.value}>
                {l.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="relative min-w-48 flex-1">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            className="pl-8"
            aria-label="Search the logs"
          />
        </div>
        <div className="flex items-center gap-2">
          <Switch
            id="follow"
            checked={follow}
            onCheckedChange={(on) => {
              userScroll.current = false;
              setFollow(on);
            }}
          />
          <Label htmlFor="follow">Auto-follow</Label>
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={lines.length === 0}
          onClick={() =>
            copyText(lines.map((l) => l.text).join('\n')).then(
              () => toast.success(`${lines.length} ${plural(lines.length, 'line')} copied`),
              (e: Error) => toast.error(e.message),
            )
          }
        >
          <Copy /> Copy
        </Button>
        <Button variant="ghost" size="sm" disabled={lines.length === 0} onClick={hideCurrentLogs}>
          <Eraser /> Clear view
        </Button>
      </div>

      <div className={cn(GLASS, 'relative min-h-0 flex-1 overflow-hidden')}>
        <section
          ref={scroller}
          aria-label="Logs"
          className="h-full overflow-auto bg-well inset-shadow-well p-3"
          // Following only stops on a user gesture: a filter that changes the height must not stop it.
          onWheel={(e) => {
            if (e.deltaY < 0) userScroll.current = true;
          }}
          onPointerDown={() => (userScroll.current = true)}
          onPointerUp={() => (userScroll.current = false)}
          onKeyDown={(e) => {
            if (['ArrowUp', 'PageUp', 'Home'].includes(e.key)) userScroll.current = true;
          }}
          onScroll={(e) => {
            const el = e.currentTarget;
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK_PX;
            if (atBottom && !follow) setFollow(true);
            else if (!atBottom && follow && userScroll.current) setFollow(false);
            if (atBottom) userScroll.current = false;
          }}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: the scrolling area must be reachable from the keyboard
          tabIndex={0}
        >
          {lines.length === 0 ? (
            <Alert>
              <ScrollText />
              <AlertTitle>{EMPTY[empty].title}</AlertTitle>
              <AlertDescription>{EMPTY[empty].description}</AlertDescription>
            </Alert>
          ) : (
            <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((v) => (
                <div
                  key={v.key}
                  data-index={v.index}
                  ref={virtualizer.measureElement}
                  className="absolute inset-x-0 top-0"
                  style={{ transform: `translateY(${v.start}px)` }}
                >
                  <LogRow line={lines[v.index]!} query={query.trim()} />
                </div>
              ))}
            </div>
          )}
        </section>
        {!follow && lines.length > 0 && (
          <Button
            size="sm"
            className="absolute right-4 bottom-4 shadow-lg"
            onClick={() => {
              userScroll.current = false;
              setFollow(true);
            }}
          >
            <ArrowDownToLine /> Resume following
          </Button>
        )}
      </div>
    </div>
  );
}
