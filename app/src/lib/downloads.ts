import { type DownloadItem, type DownloadLive, isDownloadActive } from '@llama-webui/shared';
import { toast } from 'sonner';
import { create } from 'zustand';
import { byId, call, client } from './api';
import { useModels } from './models';
import { onWs, useWs } from './ws';

export const getHfStatus = () => call(client.hf.status.$get());
export const searchHf = (q: string, signal?: AbortSignal) =>
  call(client.hf.search.$get({ query: { q } }, { init: { signal } }));
export const getHfRepo = (id: string, signal?: AbortSignal) =>
  call(client.hf.repo.$get({ query: { id } }, { init: { signal } }));

/**
 * Absolute path of a downloaded item's model (its first shard): what the models list and the detail dialog use.
 * The key, not `files[0]`: shards already on disk when it was queued are not in `files`.
 */
export const downloadPath = (i: DownloadItem) => `${i.dir}/${i.key}`;

interface DownloadsState {
  items: DownloadItem[];
  live: DownloadLive | null;
  load(): Promise<void>;
  /** Queues variants of a repo (pinned to `revision`); false if refused (toast shown). */
  enqueue(repo: string, revision: string, keys: string[]): Promise<boolean>;
  cancel(id: number): Promise<void>;
  retry(id: number): Promise<void>;
  remove(id: number): Promise<void>;
  clearFinished(): Promise<void>;
}

const fail = (e: unknown) => toast.error(e instanceof Error ? e.message : String(e));

export const useDownloads = create<DownloadsState>((set) => ({
  items: [],
  live: null,

  async load() {
    try {
      const { items, live } = await call(client.downloads.$get());
      set({ items, live });
    } catch {
      // Offline: the WS reconnection reloads.
    }
  },

  async enqueue(repo, revision, keys) {
    try {
      const { items } = await call(client.downloads.$post({ json: { repo, revision, keys } }));
      if (items.length === 0) toast.info('Already downloaded');
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  },

  async cancel(id) {
    await call(client.downloads[':id'].$delete(byId(id))).catch(fail);
  },

  async retry(id) {
    await call(client.downloads[':id'].retry.$post(byId(id))).catch(fail);
  },

  async remove(id) {
    await call(client.downloads[':id'].$delete(byId(id))).catch(fail);
  },

  async clearFinished() {
    await call(client.downloads.clear.$post()).catch(fail);
  },
}));

/** Opens a model's detail dialog on the Models page (router imported lazily: no cycle with the pages). */
const showModel = (path: string) =>
  void import('@/app/router').then(({ router }) => router.navigate(`/models?open=${encodeURIComponent(path)}`));

let started = false;
/** WS subscription (once, at startup): queue changes and progress; a finished download rescans the models. */
export function startDownloadsSync(): void {
  if (started) return;
  started = true;
  onWs('download-progress', (m) => useDownloads.setState({ live: m.payload }));
  onWs('download', ({ payload: item }) => {
    const { items } = useDownloads.getState();
    const prev = items.find((i) => i.id === item.id);
    useDownloads.setState({ items: prev ? items.map((i) => (i.id === item.id ? item : i)) : [...items, item] });
    if (prev?.status === item.status) return;
    const label = item.quant ? `${item.name} (${item.quant})` : item.name;
    if (item.status === 'done') {
      void useModels.getState().refresh();
      toast.success(`${label} downloaded`, {
        description: item.repo,
        action: { label: 'Details', onClick: () => showModel(downloadPath(item)) },
      });
    } else if (item.status === 'error') {
      toast.error(`Download of ${label} failed`, { description: item.error ?? undefined });
    }
  });
  onWs('download-deleted', ({ payload: { ids } }) => {
    const gone = new Set(ids);
    useDownloads.setState({ items: useDownloads.getState().items.filter((i) => !gone.has(i.id)) });
  });
  useWs.subscribe((s, prev) => {
    if (s.status === 'open' && prev.status !== 'open') void useDownloads.getState().load();
  });
}

/** Overall progress of the queue (0–1), null when idle: finished bytes of the active items plus the live file. */
export function queueProgress(items: DownloadItem[], live: DownloadLive | null): number | null {
  const active = items.filter((i) => isDownloadActive(i.status));
  if (active.length === 0) return null;
  const total = active.reduce((a, i) => a + i.totalBytes, 0);
  const done = active.reduce((a, i) => a + (live?.id === i.id ? live.bytesDone : i.bytesDone), 0);
  return total > 0 ? done / total : 0;
}
