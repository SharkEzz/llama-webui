import { Api, type DownloadRequest } from '@llama-webui/shared';
import { Effect, type FileSystem, type Path } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import type { HfClient } from '../hf/HfClient.ts';
import { downloadInputs } from '../hf/repo.ts';
import type { SettingsRepo } from '../settings/SettingsRepo.ts';
import { Downloads } from './Downloads.ts';

/**
 * The endpoints of `/api/downloads`: the queue, a request for variants of a repository (checked against the Hub, at
 * the commit it names, before anything is queued), a retry, a removal and the clearing of the finished items. The
 * queue publishes every change on `/ws` (`download`, `download-progress`, `download-deleted`).
 */
export const DownloadsHandlers = HttpApiBuilder.group(
  Api,
  'downloads',
  Effect.fn(function* (handlers) {
    const downloads = yield* Downloads;
    // Taken when the routes are built: a handler then needs nothing from the request.
    const services = yield* Effect.context<HfClient | SettingsRepo | FileSystem.FileSystem | Path.Path>();

    const create = Effect.fn('DownloadsHandlers.create')(function* (request: DownloadRequest) {
      const inputs = yield* Effect.provideContext(downloadInputs(request), services);
      return { items: yield* downloads.enqueue(inputs) };
    });

    return handlers
      .handle('list', () => downloads.list)
      .handle('create', ({ payload }) => create(payload))
      .handle('clear', () => Effect.map(downloads.clear, (deleted) => ({ deleted })))
      .handle('remove', ({ params }) => downloads.remove(params.id))
      .handle('retry', ({ params }) => downloads.retry(params.id));
  }),
);
