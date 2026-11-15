import { Api } from '@llama-webui/shared';
import { Effect, type FileSystem, type Path, String as Str } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import type { SettingsRepo } from '../settings/SettingsRepo.ts';
import { HfClient } from './HfClient.ts';
import { describeRepo } from './repo.ts';

/**
 * The endpoints of `/api/hf`: a repository's GGUF variants and what of them is on disk, the search, the token's
 * account. Each Hub call belongs to its request: a client that leaves aborts it.
 */
export const HfHandlers = HttpApiBuilder.group(
  Api,
  'hf',
  Effect.fn(function* (handlers) {
    const client = yield* HfClient;
    // Taken when the routes are built: a handler then needs nothing from the request.
    const services = yield* Effect.context<HfClient | SettingsRepo | FileSystem.FileSystem | Path.Path>();

    return handlers
      .handle('repo', ({ query }) =>
        // No revision, or an empty one: the default branch.
        Effect.provideContext(
          describeRepo(query.id, query.revision === undefined || Str.isEmpty(query.revision) ? 'main' : query.revision),
          services,
        ),
      )
      .handle('search', ({ query }) => client.search(query.q))
      .handle('status', () => client.status);
  }),
);
