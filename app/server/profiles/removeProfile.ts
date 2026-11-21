import { activeProfileId, ProfileRunning } from '@llama-webui/shared';
import { Effect } from 'effect';
import { SettingsRepo } from '../settings/SettingsRepo.ts';
import { Supervisor } from '../supervisor/Supervisor.ts';
import { ProfilesRepo } from './ProfilesRepo.ts';

/** Refuses the profile of the server llama-webui runs (starting, ready or stopping). */
export const refuseRunning = Effect.fn('refuseRunning')(function* (id: number) {
  const supervisor = yield* Supervisor;
  const state = yield* supervisor.state;
  if (activeProfileId(state) === id) {
    return yield* ProfileRunning.make({ message: 'This profile belongs to the running server: stop it first' });
  }
});

/**
 * Clears the `defaultProfileId` setting when it names one of `ids`. Called once the profiles are deleted (after the
 * commit of a transaction that deletes them) so a rollback does not clear the setting.
 */
export const clearDefaultProfile = Effect.fn('clearDefaultProfile')(function* (ids: ReadonlyArray<number>) {
  const settings = yield* SettingsRepo;
  const current = yield* settings.get;
  if (current.defaultProfileId !== null && ids.includes(current.defaultProfileId)) {
    yield* Effect.orDie(settings.patch({ defaultProfileId: null }));
  }
});

/**
 * Deletes a profile and, when it was the default one, clears the `defaultProfileId` setting. The profile of the
 * server llama-webui runs is refused before anything else.
 */
export const removeProfile = Effect.fn('removeProfile')(function* (id: number) {
  yield* refuseRunning(id);
  const profiles = yield* ProfilesRepo;
  yield* profiles.remove(id);
  yield* clearDefaultProfile([id]);
});
