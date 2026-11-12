import { DownloadRequestSchema, isDownloadActive } from '@llama-webui/shared';
import { Hono } from 'hono';
import type { DownloadsRepo } from '../db/downloads';
import type { SettingsRepo } from '../db/settings';
import type { HfClient } from '../hf/client';
import type { DownloadQueue } from '../hf/downloader';
import { describeRepo, downloadInputs } from '../hf/repo';
import { body, type Env, HttpError, id } from '../http';
import { expandHome } from '../supervisor/args';

export interface HfRouteDeps {
  hf: HfClient;
  downloads: DownloadQueue;
  downloadsRepo: DownloadsRepo;
  settings: SettingsRepo;
}

export function hfRoutes({ hf, downloads, downloadsRepo, settings }: HfRouteDeps) {
  const modelsDir = () => expandHome(settings.get().modelsDir);

  // `/api/downloads/clear` before `/api/downloads/:id` (Hono matches in registration order).
  return (
    new Hono<Env>()
      .get('/api/hf/status', async (c) => c.json(await hf.status()))
      .get('/api/hf/search', async (c) => {
        const q = (new URL(c.req.url).searchParams.get('q') ?? '').trim();
        if (!q || q.length > 200) throw new HttpError(400, 'Search text expected (200 characters at most)');
        return c.json(await hf.search(q, { signal: c.req.raw.signal }));
      })
      .get('/api/hf/repo', async (c) => {
        const q = new URL(c.req.url).searchParams;
        const repo = await describeRepo(hf, q.get('id') ?? '', {
          modelsDir: modelsDir(),
          revision: q.get('revision') || undefined,
          signal: c.req.raw.signal,
        });
        return c.json(repo);
      })
      .get('/api/downloads', (c) => c.json({ items: downloadsRepo.list(), live: downloads.live }))
      .post('/api/downloads', body(DownloadRequestSchema, { object: true }), async (c) => {
        const items = await downloads.enqueue(await downloadInputs(hf, c.req.valid('json'), modelsDir()));
        return c.json({ items }, 202);
      })
      .post('/api/downloads/clear', (c) => c.json({ deleted: downloads.clearFinished().length }))
      /** Cancels a queued or running download, removes a finished one from the list. */
      .delete('/api/downloads/:id', id('Download'), async (c) => {
        const { id } = c.req.valid('param');
        const item = downloadsRepo.get(id);
        if (item && isDownloadActive(item.status)) await downloads.cancel(id);
        else downloads.remove(id);
        return c.body(null, 204);
      })
      .post('/api/downloads/:id/retry', id('Download'), async (c) =>
        c.json(await downloads.retry(c.req.valid('param').id), 202),
      )
  );
}
