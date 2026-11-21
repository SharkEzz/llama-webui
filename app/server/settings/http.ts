import { Api, type SettingsPatched } from '@llama-webui/shared';
import { Effect, Equal } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import { Monitor, monitorSettingsOf } from '../monitor/Monitor.ts';
import { SettingsRepo } from './SettingsRepo.ts';

/**
 * `GET /api/settings` and `PATCH /api/settings`, on the repository; a patch that changes what the monitor follows is
 * then handed to it.
 */
export const SettingsHandlers = HttpApiBuilder.group(
  Api,
  'settings',
  Effect.fn(function* (handlers) {
    const repo = yield* SettingsRepo;
    const monitor = yield* Monitor;

    /**
     * The patch saved, then applied by the monitor when it changed what the monitor follows (the monitor reads what is
     * stored); one it could not apply is saved all the same, with a warning.
     */
    const patch = Effect.fn('SettingsHandlers.patch')(function* (payload: Readonly<Record<string, unknown>>) {
      const before = yield* repo.get;
      const next = yield* repo.patch(payload);
      if (Equal.equals(monitorSettingsOf(before), monitorSettingsOf(next))) return next;
      return yield* monitor.configure.pipe(
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
