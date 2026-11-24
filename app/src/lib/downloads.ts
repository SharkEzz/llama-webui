import {
  type DownloadItem,
  type DownloadLive,
  type HfRepo,
  type HfSearchHit,
  type HfStatus,
  isDownloadActive,
  type WsMessage,
} from '@llama-webui/shared';
import { toast } from 'sonner';
import { create } from 'zustand';
import { errorMessage, call as webCall } from './api';
import { debugStore } from './debug/stores';
import { useModels } from './models';
import { onWs, useWs } from './ws';

/**
 * Absolute path of a downloaded item's model (its first shard): what the models list and the detail dialog use.
 * The key, not `files[0]`: shards already on disk when it was queued are not in `files`.
 */
export const downloadPath = (i: DownloadItem) => `${i.dir}/${i.key}`;

/** The messages of the queue on the push channel. */
type DownloadMessage = Extract<WsMessage, { type: 'download' | 'download-progress' | 'download-deleted' }>;

interface DownloadsState {
  items: ReadonlyArray<DownloadItem>;
  live: DownloadLive | null;
  load: () => Promise<void>;
  /** Queues variants of a repo (pinned to `revision`) and adds those not listed yet; false if refused (message shown). */
  enqueue: (repo: string, revision: string, keys: ReadonlyArray<string>) => Promise<boolean>;
  cancel: (id: number) => Promise<void>;
  retry: (id: number) => Promise<void>;
  remove: (id: number) => Promise<void>;
  clearFinished: () => Promise<void>;
  /** A message of the queue (`download`, `download-progress`, `download-deleted`). */
  receive: (m: DownloadMessage) => void;
  /**
   * A repository's GGUF variants (`revision` omitted: its default branch). Rejects with the Hub's tagged error
   * (`HfGated`, `HfNotFound`, `HfUnauthorized`, `HfRateLimited`, `HfUnreachable`, `HfInvalidPath`).
   */
  repo: (id: string, signal?: AbortSignal) => Promise<HfRepo>;
  /** The GGUF repositories matching `q`. */
  search: (q: string, signal?: AbortSignal) => Promise<ReadonlyArray<HfSearchHit>>;
  /** The token in use and its account. */
  status: () => Promise<HfStatus>;
}

/** The calls the store makes: the web's, or in a test the same calls on a fake `fetch` (`makeCall(Api, fetchImpl)`). */
export interface DownloadsCalls {
  readonly call: typeof webCall;
  /** A download finished: what is in the models folder changed. */
  readonly downloaded?: (item: DownloadItem) => void;
  /** Goes to a page of the app: a finished download's Details opens its model on the Models page. */
  readonly navigate?: (to: string) => void;
}

/**
 * What the queue's messages changed while a request was in flight: each item's last state (null: deleted), and the
 * live progress. Newer than the reply, read before them: the reply does not undo them.
 */
interface Touched {
  readonly items: Map<number, DownloadItem | null>;
  live?: { readonly value: DownloadLive | null };
}

/** The list read by `load`, with what the messages changed during the request in place of what it says. */
const merged = (items: ReadonlyArray<DownloadItem>, touched: Touched): ReadonlyArray<DownloadItem> => {
  const listed = new Set(items.map((i) => i.id));
  const kept = items.flatMap((i) => {
    const now = touched.items.get(i.id);
    return now === undefined ? [i] : now === null ? [] : [now];
  });
  const added = [...touched.items.values()].filter((i): i is DownloadItem => i !== null && !listed.has(i.id));
  return [...kept, ...added];
};

const fail = (e: unknown) => void toast.error(errorMessage(e));

/** `items` with `item` in place of the one with its id, or added at the end. */
const upsert = (items: ReadonlyArray<DownloadItem>, item: DownloadItem) =>
  items.some((i) => i.id === item.id) ? items.map((i) => (i.id === item.id ? item : i)) : [...items, item];

/**
 * `items` with `item` added if it is not there yet. A reply only adds: the queue may have moved the item on (started,
 * failed it) before the reply reached the page, and its `download` message, already applied, is the newer state.
 */
const addMissing = (items: ReadonlyArray<DownloadItem>, item: DownloadItem) =>
  items.some((i) => i.id === item.id) ? items : [...items, item];

/** The page of the Models list that opens the detail dialog of the model at `path`. */
const modelPage = (path: string) => `/models?open=${encodeURIComponent(path)}`;

/** The download queue's store, making its calls through `calls`. */
export const makeDownloadsStore = ({ call, downloaded, navigate }: DownloadsCalls) => {
  /** One per request in flight: `receive` records in each what it changes. */
  const inFlight = new Set<Touched>();
  /** `request`'s reply, and what the messages changed while it was awaited. */
  const during = async <A>(request: () => Promise<A>): Promise<{ readonly reply: A; readonly touched: Touched }> => {
    const touched: Touched = { items: new Map() };
    inFlight.add(touched);
    try {
      return { reply: await request(), touched };
    } finally {
      inFlight.delete(touched);
    }
  };
  /** `items` with those of a reply that are missing, but for one deleted while the reply was awaited. */
  const addReplied = (items: ReadonlyArray<DownloadItem>, replied: ReadonlyArray<DownloadItem>, touched: Touched) =>
    replied.reduce((acc, i) => (touched.items.get(i.id) === null ? acc : addMissing(acc, i)), items);

  return create<DownloadsState>((set, get) => ({
    items: [],
    live: null,

    async load() {
      try {
        const { reply, touched } = await during(() => call((api) => api.downloads.list()));
        set({ items: merged(reply.items, touched), live: touched.live ? touched.live.value : reply.live });
      } catch {
        // Offline: the WS reconnection reloads.
      }
    },

    async enqueue(repo, revision, keys) {
      try {
        const { reply, touched } = await during(() =>
          call((api) => api.downloads.create({ payload: { repo, revision, keys } })),
        );
        if (reply.items.length === 0) toast.info('Already downloaded');
        set({ items: addReplied(get().items, reply.items, touched) });
        return true;
      } catch (e) {
        fail(e);
        return false;
      }
    },

    async cancel(id) {
      await call((api) => api.downloads.remove({ params: { id } })).catch(fail);
    },

    async retry(id) {
      await during(() => call((api) => api.downloads.retry({ params: { id } }))).then(
        ({ reply, touched }) => set({ items: addReplied(get().items, [reply], touched) }),
        fail,
      );
    },

    async remove(id) {
      await call((api) => api.downloads.remove({ params: { id } })).catch(fail);
    },

    async clearFinished() {
      await call((api) => api.downloads.clear()).catch(fail);
    },

    receive(m) {
      switch (m.type) {
        case 'download-progress':
          for (const touched of inFlight) touched.live = { value: m.payload };
          set({ live: m.payload });
          return;
        case 'download-deleted': {
          const gone = new Set(m.payload.ids);
          for (const touched of inFlight) for (const id of gone) touched.items.set(id, null);
          set({ items: get().items.filter((i) => !gone.has(i.id)) });
          return;
        }
        case 'download': {
          const item = m.payload;
          for (const touched of inFlight) touched.items.set(item.id, item);
          const prev = get().items.find((i) => i.id === item.id);
          set({ items: upsert(get().items, item) });
          if (prev?.status === item.status) return;
          const label = item.quant ? `${item.name} (${item.quant})` : item.name;
          if (item.status === 'done') {
            downloaded?.(item);
            toast.success(`${label} downloaded`, {
              description: item.repo,
              action: { label: 'Details', onClick: () => navigate?.(modelPage(downloadPath(item))) },
            });
          } else if (item.status === 'error') {
            toast.error(`Download of ${label} failed`, { description: item.error ?? undefined });
          }
        }
      }
    },

    repo: (id, signal) => call((api) => api.hf.repo({ query: { id } }), { signal }),
    search: (q, signal) => call((api) => api.hf.search({ query: { q } }), { signal }),
    status: () => call((api) => api.hf.status()),
  }));
};

/** How the app goes to a page: the router's, given to `startDownloadsSync` by `main.tsx` (no import of the pages). */
let navigateTo: ((to: string) => void) | undefined;

/** A finished download rescans the models. */
export const useDownloads = makeDownloadsStore({
  call: webCall,
  downloaded: () => void useModels.getState().refresh(),
  navigate: (to) => navigateTo?.(to),
});

let started = false;
/**
 * WS subscription (once, at startup): queue changes and progress; the queue read again on each (re)connection.
 * `navigate` is the router's, which a finished download's Details uses.
 */
export function startDownloadsSync(options: { readonly navigate: (to: string) => void }): void {
  navigateTo = options.navigate;
  if (started) return;
  started = true;
  const receive = (m: DownloadMessage) => useDownloads.getState().receive(m);
  onWs('download-progress', receive);
  onWs('download', receive);
  onWs('download-deleted', receive);
  useWs.subscribe((s, prev) => {
    if (s.status === 'open' && prev.status !== 'open') void useDownloads.getState().load();
  });
}

/** Overall progress of the queue (0–1), null when idle: finished bytes of the active items plus the live file. */
export function queueProgress(items: ReadonlyArray<DownloadItem>, live: DownloadLive | null): number | null {
  const active = items.filter((i) => isDownloadActive(i.status));
  if (active.length === 0) return null;
  const total = active.reduce((a, i) => a + i.totalBytes, 0);
  const done = active.reduce((a, i) => a + (live?.id === i.id ? live.bytesDone : i.bytesDone), 0);
  return total > 0 ? done / total : 0;
}

debugStore('downloads', useDownloads);
