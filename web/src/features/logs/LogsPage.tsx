import { filterLogs, type LogLevel } from '@llama-webui/shared';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDownToLine, Copy, Eraser, ScrollText, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { GLASS } from '@/components/glass/glass';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { copyText } from '@/lib/clipboard';
import { hideCurrentLogs, useLogs } from '@/lib/logs';
import { cn } from '@/lib/utils';
import { LogRow } from './LogRow';

const LEVELS: { value: LogLevel; label: string }[] = [
  { value: 'debug', label: 'Debug et plus' },
  { value: 'info', label: 'Info et plus' },
  { value: 'warn', label: 'Avertissements et erreurs' },
  { value: 'error', label: 'Erreurs seulement' },
];

const BOTTOM_SLACK_PX = 40;

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
    <div className="flex h-[calc(100dvh-7.5rem)] min-h-96 flex-col gap-4">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-3xl font-semibold tracking-tight">Logs</h1>
        <span className="text-sm text-muted-foreground">
          <span className="num text-foreground/80">{lines.length.toLocaleString('fr-FR')}</span> ligne
          {lines.length > 1 ? 's' : ''}
          {lines.length !== all.length && (
            <>
              {' '}
              sur <span className="num">{all.length.toLocaleString('fr-FR')}</span>
            </>
          )}
        </span>
      </header>

      <div className={cn(GLASS, 'flex flex-wrap items-center gap-3 p-3')}>
        <Select items={LEVELS} value={minLevel} onValueChange={(v) => v && setMinLevel(v as LogLevel)}>
          <SelectTrigger className="w-56" aria-label="Niveau minimal">
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
            placeholder="Rechercher"
            className="pl-8"
            aria-label="Rechercher dans les logs"
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
          <Label htmlFor="follow">Suivi auto</Label>
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={lines.length === 0}
          onClick={() =>
            copyText(lines.map((l) => l.text).join('\n')).then(
              () => toast.success(`${lines.length} lignes copiées`),
              (e: Error) => toast.error(e.message),
            )
          }
        >
          <Copy /> Copier
        </Button>
        <Button variant="ghost" size="sm" disabled={lines.length === 0} onClick={hideCurrentLogs}>
          <Eraser /> Vider l'affichage
        </Button>
      </div>

      <div className={cn(GLASS, 'relative min-h-0 flex-1 overflow-hidden')}>
        <section
          ref={scroller}
          aria-label="Journaux"
          className="h-full overflow-auto p-3"
          // Le suivi ne se coupe que sur un geste de l'utilisateur : un filtre qui change la hauteur ne doit pas l'arrêter.
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
          // biome-ignore lint/a11y/noNoninteractiveTabindex: la zone défilante doit être atteignable au clavier
          tabIndex={0}
        >
          {lines.length === 0 ? (
            <Alert>
              <ScrollText />
              <AlertTitle>{all.length === 0 ? 'Aucun log' : 'Aucune ligne ne correspond aux filtres'}</AlertTitle>
              <AlertDescription>
                {all.length === 0
                  ? 'Démarrez llama-server depuis la page Serveur.'
                  : 'Baissez le niveau minimal ou changez la recherche.'}
              </AlertDescription>
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
            <ArrowDownToLine /> Reprendre le suivi
          </Button>
        )}
      </div>
    </div>
  );
}
