import type { AppDeps } from '../deps';
import { HttpError, notFound } from '../http';
import { buildCommand } from './args';
import { SupervisorError } from './supervisor';

/** Supervisor refusals (port in use, operation in progress…) become 409s; a running benchmark owns the GPUs. */
export async function lifecycle({ benchRunner }: Pick<AppDeps, 'benchRunner'>, fn: () => Promise<void>): Promise<void> {
  try {
    if (benchRunner.busy) throw new HttpError(409, 'A benchmark is running');
    await fn();
  } catch (e) {
    if (e instanceof SupervisorError) throw new HttpError(409, e.message);
    throw e;
  }
}

/** The launch command of a profile, re-read from the DB (profile changes are taken into account). */
export function commandFor({ profiles, settings }: Pick<AppDeps, 'profiles' | 'settings'>, profileId: unknown) {
  const id = Number(profileId);
  const profile = Number.isInteger(id) ? profiles.get(id) : null;
  if (!profile) throw notFound('Profile');
  return buildCommand(profile, settings.get());
}

/** The profile just started becomes the default one. */
export function remember({ settings }: Pick<AppDeps, 'settings'>, profileId: number): void {
  if (settings.get().defaultProfileId !== profileId) settings.patch({ defaultProfileId: profileId });
}
