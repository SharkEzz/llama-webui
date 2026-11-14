import { Effect } from 'effect';
import { SettingsRepo } from '../settings/SettingsRepo.ts';
import { ProfilesRepo } from './ProfilesRepo.ts';

/**
 * Deletes a profile and, when it was the default one, clears the `defaultProfileId` setting. E3 adds the refusal of
 * the running server's profile here.
 */
export const removeProfile = Effect.fn('removeProfile')(function* (id: number) {
  const profiles = yield* ProfilesRepo;
  const settings = yield* SettingsRepo;
  yield* profiles.remove(id);
  const current = yield* settings.get;
  if (current.defaultProfileId === id) yield* Effect.orDie(settings.patch({ defaultProfileId: null }));
});
