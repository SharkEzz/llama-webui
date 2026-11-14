import { Api, type SettingsPatched } from '@llama-webui/shared';
import { Effect } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import { Monitor } from '../monitor/Monitor.ts';
import { SettingsRepo } from './SettingsRepo.ts';

/** `GET /api/settings` and `PATCH /api/settings`, on the repository; a patch is then handed to the monitor. */
export const SettingsHandlers = HttpApiBuilder.group(
  Api,
  'settings',
  Effect.fn(function* (handlers) {
    const repo = yield* SettingsRepo;
    const monitor = yield* Monitor;

    /** The patch saved, then applied by the monitor; one it could not apply is saved all the same, with a warning. */
    const patch = Effect.fn('SettingsHandlers.patch')(function* (payload: Readonly<Record<string, unknown>>) {
      const next = yield* repo.patch(payload);
      return yield* monitor.configure(next).pipe(
        Effect.as<SettingsPatched>(next),
        // A 500 would say the change was lost.
        Effect.catchTag('CollectorsNotApplied', (error) => {
          const warning = `Saved, but the monitor could not apply it: ${error.message}`;
          return Effect.as(Effect.logWarning(warning), { ...next, warning });
        }),
      );
    });

    return handlers.handle('get', () => repo.get).handle('patch', ({ payload }) => patch(payload));
  }),
);
