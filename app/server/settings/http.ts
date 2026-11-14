import { Api } from '@llama-webui/shared';
import { Effect } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import { SettingsRepo } from './SettingsRepo.ts';

/** `GET /api/settings` and `PATCH /api/settings`, on the repository. */
export const SettingsHandlers = HttpApiBuilder.group(
  Api,
  'settings',
  Effect.fn(function* (handlers) {
    const repo = yield* SettingsRepo;
    return handlers.handle('get', () => repo.get).handle('patch', ({ payload }) => repo.patch(payload));
  }),
);
