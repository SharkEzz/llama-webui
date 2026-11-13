import type { AppDeps } from '../deps';
import { HttpError } from '../http';

/** Deletes a profile: refused for the running server's, and no longer the default one. */
export function removeProfile(
  { profiles, settings, activeProfileId }: Pick<AppDeps, 'profiles' | 'settings' | 'activeProfileId'>,
  id: number,
): void {
  if (activeProfileId() === id) throw new HttpError(409, 'This profile belongs to the running server: stop it first');
  profiles.remove(id);
  if (settings.get().defaultProfileId === id) settings.patch({ defaultProfileId: null });
}
