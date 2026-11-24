import { useDeferredValue, useState } from 'react';
import { Input } from '@/components/ui/input';
import { type StoreChange, type StoreStats, useDebugCapture } from '@/lib/debug/capture';
import { diffPaths, preview } from '@/lib/debug/inspect';
import { debugStores } from '@/lib/debug/stores';
import { fmt, formatTime, plural } from '@/lib/format';
import { cn } from '@/lib/utils';
import { JsonTree } from './JsonTree';
import { Chip, Empty, Section, SHOWN } from './parts';

/** How long a store's name stays lit after it changed. */
const FLASH_MS = 1000;

/** One store in the list: its name, then its changes, their rate and the `set()`s that changed nothing. */
function StoreItem({
  name,
  stats,
  now,
  selected,
  onSelect,
}: {
  name: string;
  stats: StoreStats | undefined;
  now: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const lit = stats?.last !== undefined && now - stats.last < FLASH_MS;
  return (
    <li>
      <button
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
        className={cn(
          'flex w-full flex-col rounded px-2 py-1 text-left hover:bg-accent',
          selected && 'bg-primary/15 hover:bg-primary/20',
        )}
      >
        <span className="flex items-center gap-1.5 font-mono text-xs">
          <span
            aria-hidden
            className={cn('size-1.5 shrink-0 rounded-full transition-colors', lit ? 'bg-tone-teal' : 'bg-border')}
          />
          <span className="truncate">{name}</span>
        </span>
        {stats && (
          <span className="truncate pl-3 num text-[0.65rem] text-muted-foreground">
            {stats.changes} {plural(stats.changes, 'change')}, {fmt(stats.perSecond, 1)}/s
            {stats.noops > 0 && `, ${stats.noops} no-op`}
          </span>
        )}
      </button>
    </li>
  );
}

const DIFF_TONE = { added: 'text-tone-teal', removed: 'text-destructive', changed: '' } as const;

/** What a change did, path by path, worked out when its row is opened. */
function ChangeDiff({ change }: { change: StoreChange }) {
  const lines = change.keys.map((key) => diffPaths(change.prev[key], change.next[key], { root: key }));
  const entries = lines.flatMap((l) => l.entries);
  return (
    <ul className="mx-1.5 mb-1.5 flex flex-col gap-0.5 rounded bg-muted/50 p-2">
      {entries.map((e) => (
        <li key={e.path} className={cn('flex min-w-0 flex-wrap gap-x-1.5', DIFF_TONE[e.kind])}>
          <span className="font-semibold">{e.path}</span>
          {e.kind === 'added' && <span title={preview(e.after, 2000)}>+ {preview(e.after)}</span>}
          {e.kind === 'removed' && <span title={preview(e.before, 2000)}>− {preview(e.before)}</span>}
          {e.kind === 'changed' && (
            <span className="min-w-0">
              <span className="text-destructive line-through" title={preview(e.before, 2000)}>
                {preview(e.before, 40)}
              </span>{' '}
              → <span className="text-tone-teal">{preview(e.after, 40)}</span>
            </span>
          )}
        </li>
      ))}
      {entries.length === 0 && <li className="text-muted-foreground">Same content, new references.</li>}
      {lines.some((l) => l.truncated) && <li className="text-muted-foreground">More differences not shown.</li>}
    </ul>
  );
}

function ChangeRow({ change, showStore }: { change: StoreChange; showStore: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <details onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded px-1.5 py-1 hover:bg-accent [&::-webkit-details-marker]:hidden">
          <span className="num text-muted-foreground">{formatTime(change.at)}</span>
          {showStore && <span className="shrink-0 font-semibold">{change.store}</span>}
          <span className="min-w-0 flex-1 truncate">{change.keys.join(', ')}</span>
        </summary>
        {open && <ChangeDiff change={change} />}
      </details>
    </li>
  );
}

/** The changes of one store, or of all, newest first, filtered by a key they changed. */
function Changes({ store }: { store: string | null }) {
  const changes = useDebugCapture((s) => s.view.storeChanges);
  const [search, setSearch] = useState('');
  const query = useDeferredValue(search.trim().toLowerCase());
  const matching = changes.filter(
    (c) =>
      (store === null || c.store === store) && (query === '' || c.keys.some((k) => k.toLowerCase().includes(query))),
  );
  const shown = matching.slice(-SHOWN).toReversed();

  return (
    <Section title={`Changes (last ${shown.length} of ${matching.length})`}>
      <Input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Filter by key"
        aria-label="Filter the changes by key"
        className="h-7 text-xs"
      />
      {shown.length === 0 ? (
        <Empty>{query === '' ? 'No change since the capture started.' : 'No change matches.'}</Empty>
      ) : (
        <ul className="flex flex-col font-mono text-[0.7rem]">
          {shown.map((c) => (
            <ChangeRow key={c.id} change={c} showStore={store === null} />
          ))}
        </ul>
      )}
    </Section>
  );
}

/** A store's current state as a tree, and the names of its actions. */
function State({ name }: { name: string }) {
  const store = debugStores().get(name);
  if (!store) return <Empty>This store is not loaded.</Empty>;
  const state = store.getState();
  const actions =
    typeof state === 'object' && state !== null
      ? Object.entries(state)
          .filter(([, v]) => typeof v === 'function')
          .map(([k]) => k)
      : [];
  return (
    <div className="flex flex-col gap-3">
      <JsonTree key={name} label={name} value={state} />
      {actions.length > 0 && (
        <p className="text-xs text-muted-foreground">
          <span className="font-medium">Actions:</span> <span className="font-mono">{actions.join(', ')}</span>
        </p>
      )}
    </div>
  );
}

/**
 * The page's Zustand stores: the list of those loaded with their activity, the state of the one selected as a tree,
 * and the log of their changes, each opening on its diff. Read again at each publication of the capture (four times a
 * second), frozen by the pause.
 */
export function StoresPanel() {
  const now = useDebugCapture((s) => s.view.at);
  const stats = useDebugCapture((s) => s.view.storeStats);
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<'state' | 'changes'>('state');
  const names = [...debugStores().keys()].toSorted((a, b) => a.localeCompare(b));
  const byName = new Map(stats.map((s) => [s.store, s]));
  const total = stats.reduce((sum, s) => sum + s.changes, 0);

  return (
    <div className="@container h-full">
      <div className="flex h-full flex-col gap-3 pt-3 @lg:flex-row">
        <nav aria-label="Stores" className="max-h-32 shrink-0 overflow-y-auto @lg:max-h-none @lg:w-44">
          <ul className="flex flex-col">
            <li>
              <button
                type="button"
                aria-pressed={selected === null}
                onClick={() => setSelected(null)}
                className={cn(
                  'flex w-full flex-col rounded px-2 py-1 text-left hover:bg-accent',
                  selected === null && 'bg-primary/15 hover:bg-primary/20',
                )}
              >
                <span className="text-xs font-medium">All stores</span>
                <span className="num text-[0.65rem] text-muted-foreground">
                  {names.length} loaded, {total} {plural(total, 'change')}
                </span>
              </button>
            </li>
            {names.map((name) => (
              <StoreItem
                key={name}
                name={name}
                stats={byName.get(name)}
                now={now}
                selected={selected === name}
                onSelect={() => setSelected(name)}
              />
            ))}
          </ul>
        </nav>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto">
          {selected === null ? (
            <Changes store={null} />
          ) : (
            <>
              <div className="flex items-center gap-1">
                <h3 className="mr-auto truncate font-mono text-xs font-semibold">{selected}</h3>
                <Chip pressed={mode === 'state'} onClick={() => setMode('state')}>
                  state
                </Chip>
                <Chip pressed={mode === 'changes'} onClick={() => setMode('changes')}>
                  changes {byName.get(selected)?.changes ?? 0}
                </Chip>
              </div>
              {mode === 'state' ? <State name={selected} /> : <Changes store={selected} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
