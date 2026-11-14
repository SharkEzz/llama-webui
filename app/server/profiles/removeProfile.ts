import { activeProfileId, ProfileRunning } from '@llama-webui/shared';
import { Effect } from 'effect';
import { SettingsRepo } from '../settings/SettingsRepo.ts';
import { Supervisor } from '../supervisor/Supervisor.ts';
import { ProfilesRepo } from './ProfilesRepo.ts';

/**
 * Deletes a profile and, when it was the default one, clears the `defaultProfileId` setting. The profile of the
 * server llama-webui runs (starting, ready or stopping) is refused before anything else.
 */
export const removeProfile = Effect.fn('removeProfile')(function* (id: number) {
  const supervisor = yield* Supervisor;
  const state = yield* supervisor.state;
  if (activeProfileId(state) === id) {
    return yield* ProfileRunning.make({ message: 'This profile belongs to the running server: stop it first' });
  }
  const profiles = yield* ProfilesRepo;
  const settings = yield* SettingsRepo;
  yield* profiles.remove(id);
  const current = yield* settings.get;
  if (current.defaultProfileId === id) yield* Effect.orDie(settings.patch({ defaultProfileId: null }));
});
