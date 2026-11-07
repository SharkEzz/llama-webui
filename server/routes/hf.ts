import { DownloadRequestSchema, isDownloadActive } from '@llama-webui/shared';
import type { DownloadsRepo } from '../db/downloads';
import type { SettingsRepo } from '../db/settings';
import type { HfClient } from '../hf/client';
import type { DownloadQueue } from '../hf/downloader';
import { describeRepo, downloadInputs } from '../hf/repo';
import { guarded, HttpError, idParam, jsonObject } from '../http';
import { expandHome } from '../supervisor/args';

export interface HfRouteDeps {
  hf: HfClient;
  downloads: DownloadQueue;
  downloadsRepo: DownloadsRepo;
  settings: SettingsRepo;
}

export function hfRoutes({ hf, downloads, downloadsRepo, settings }: HfRouteDeps) {
  const modelsDir = () => expandHome(settings.get().modelsDir);

  return {
    '/api/hf/status': {
      GET: guarded(async () => Response.json(await hf.status())),
    },
    '/api/hf/search': {
      GET: guarded(async (req) => {
        const q = (new URL(req.url).searchParams.get('q') ?? '').trim();
        if (!q || q.length > 200) throw new HttpError(400, 'Search text expected (200 characters at most)');
        return Response.json(await hf.search(q, { signal: req.signal }));
      }),
    },
    '/api/hf/repo': {
      GET: guarded(async (req) => {
        const q = new URL(req.url).searchParams;
        const repo = await describeRepo(hf, q.get('id') ?? '', {
          modelsDir: modelsDir(),
          revision: q.get('revision') || undefined,
          signal: req.signal,
        });
        return Response.json(repo);
      }),
    },
    '/api/downloads': {
      GET: guarded(() => Response.json({ items: downloadsRepo.list(), live: downloads.live })),
      POST: guarded(async (req) => {
        const body = DownloadRequestSchema.parse(await jsonObject(req));
        const items = await downloads.enqueue(await downloadInputs(hf, body, modelsDir()));
        return Response.json({ items }, { status: 202 });
      }),
    },
    '/api/downloads/clear': {
      POST: guarded(() => Response.json({ deleted: downloads.clearFinished().length })),
    },
    '/api/downloads/:id': {
      /** Cancels a queued or running download, removes a finished one from the list. */
      DELETE: guarded(async (req) => {
        const id = idParam(req, 'Download');
        const item = downloadsRepo.get(id);
        if (item && isDownloadActive(item.status)) await downloads.cancel(id);
        else downloads.remove(id);
        return new Response(null, { status: 204 });
      }),
    },
    '/api/downloads/:id/retry': {
      POST: guarded(async (req) => Response.json(await downloads.retry(idParam(req, 'Download')), { status: 202 })),
    },
  };
}
