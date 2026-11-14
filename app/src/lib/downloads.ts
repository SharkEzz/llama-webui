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
import { call as webCall } from './api';
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
  load(): Promise<void>;
  /** Queues variants of a repo (pinned to `revision`) and adds those not listed yet; false if refused (message shown). */
  enqueue(repo: string, revision: string, keys: ReadonlyArray<string>): Promise<boolean>;
  cancel(id: number): Promise<void>;
  retry(id: number): Promise<void>;
  remove(id: number): Promise<void>;
  clearFinished(): Promise<void>;
  /** A message of the queue (`download`, `download-progress`, `download-deleted`). */
  receive(m: DownloadMessage): void;
  /**
   * A repository's GGUF variants (`revision` omitted: its default branch). Rejects with the Hub's tagged error
   * (`HfGated`, `HfNotFound`, `HfUnauthorized`, `HfRateLimited`, `HfUnreachable`, `HfInvalidPath`).
   */
  repo(id: string, signal?: AbortSignal): Promise<HfRepo>;
  /** The GGUF repositories matching `q`. */
  search(q: string, signal?: AbortSignal): Promise<ReadonlyArray<HfSearchHit>>;
  /** The token in use and its account. */
  status(): Promise<HfStatus>;
}

/** The calls the store makes: the web's, or in a test the same calls on a fake `fetch` (`makeCall(Api, fetchImpl)`). */
export interface DownloadsCalls {
  readonly call: typeof webCall;
  /** A download finished: what is in the models folder changed. */
  readonly downloaded?: (item: DownloadItem) => void;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const fail = (e: unknown) => void toast.error(message(e));

/** `items` with `item` in place of the one with its id, or added at the end. */
const upsert = (items: ReadonlyArray<DownloadItem>, item: DownloadItem) =>
  items.some((i) => i.id === item.id) ? items.map((i) => (i.id === item.id ? item : i)) : [...items, item];

/**
 * `items` with `item` added if it is not there yet. A reply only adds: the queue may have moved the item on (started,
 * failed it) before the reply reached the page, and its `download` message, already applied, is the newer state.
 */
const addMissing = (items: ReadonlyArray<DownloadItem>, item: DownloadItem) =>
  items.some((i) => i.id === item.id) ? items : [...items, item];

/** Opens a model's detail dialog on the Models page (router imported lazily: no cycle with the pages). */
const showModel = (path: string) =>
  void import('@/app/router').then(({ router }) => router.navigate(`/models?open=${encodeURIComponent(path)}`));

/** The download queue's store, making its calls through `calls`. */
export const makeDownloadsStore = ({ call, downloaded }: DownloadsCalls) =>
  create<DownloadsState>((set, get) => ({
    items: [],
    live: null,

    async load() {
      try {
        const { items, live } = await call((api) => api.downloads.list());
        set({ items, live });
      } catch {
        // Offline: the WS reconnection reloads.
      }
    },

    async enqueue(repo, revision, keys) {
      try {
        const { items } = await call((api) => api.downloads.create({ payload: { repo, revision, keys } }));
        if (items.length === 0) toast.info('Already downloaded');
        set({ items: items.reduce(addMissing, get().items) });
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
      await call((api) => api.downloads.retry({ params: { id } })).then(
        (item) => set({ items: addMissing(get().items, item) }),
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
          set({ live: m.payload });
          return;
        case 'download-deleted': {
          const gone = new Set(m.payload.ids);
          set({ items: get().items.filter((i) => !gone.has(i.id)) });
          return;
        }
        case 'download': {
          const item = m.payload;
          const prev = get().items.find((i) => i.id === item.id);
          set({ items: upsert(get().items, item) });
          if (prev?.status === item.status) return;
          const label = item.quant ? `${item.name} (${item.quant})` : item.name;
          if (item.status === 'done') {
            downloaded?.(item);
            toast.success(`${label} downloaded`, {
              description: item.repo,
              action: { label: 'Details', onClick: () => showModel(downloadPath(item)) },
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

/** A finished download rescans the models. */
export const useDownloads = makeDownloadsStore({
  call: webCall,
  downloaded: () => void useModels.getState().refresh(),
});

let started = false;
/** WS subscription (once, at startup): queue changes and progress; the queue read again on each (re)connection. */
export function startDownloadsSync(): void {
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
