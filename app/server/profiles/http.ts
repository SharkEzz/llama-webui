import { Api, ProfileExport, ProfilesFile, parseProfileImport } from '@llama-webui/shared';
import { Effect } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import { attachment } from '../http/attachment.ts';
import type { SettingsRepo } from '../settings/SettingsRepo.ts';
import type { Supervisor } from '../supervisor/Supervisor.ts';
import { ProfilesRepo } from './ProfilesRepo.ts';
import { removeProfile } from './removeProfile.ts';

const exportFile = attachment(ProfilesFile);
const exportProfile = attachment(ProfileExport);

/** The endpoints of `/api/profiles`, on the repository. */
export const ProfilesHandlers = HttpApiBuilder.group(
  Api,
  'profiles',
  Effect.fn(function* (handlers) {
    const repo = yield* ProfilesRepo;
    // Taken when the routes are built, as `repo`: a handler then needs nothing from the request.
    const services = yield* Effect.context<ProfilesRepo | SettingsRepo | Supervisor>();

    /** Each valid profile of any JSON, created with source `import`; the parser's rejections come first. */
    const importFile = Effect.fn('ProfilesHandlers.importFile')(function* (payload: unknown) {
      const parsed = parseProfileImport(payload);
      const { imported, skipped } = yield* repo.importMany({ inputs: parsed.profiles, source: 'import' });
      return { imported, skipped: [...parsed.rejected, ...skipped] };
    });

    return handlers
      .handle('list', () => repo.list)
      .handle('create', ({ payload }) => repo.create(payload))
      .handle('exportAll', () =>
        Effect.flatMap(repo.list, (profiles) =>
          exportFile({ filename: 'llama-webui-profiles.json', body: { profiles } }),
        ),
      )
      .handle('importMany', ({ payload }) => importFile(payload))
      .handle('get', ({ params }) => repo.get(params.id))
      .handle('update', ({ params, payload }) => repo.update({ id: params.id, input: payload }))
      .handle('remove', ({ params }) => Effect.provideContext(removeProfile(params.id), services))
      .handle('duplicate', ({ params }) => repo.duplicate(params.id))
      .handle('exportOne', ({ params }) =>
        Effect.flatMap(repo.get(params.id), (profile) =>
          exportProfile({ filename: `${profile.name}.json`, body: profile }),
        ),
      );
  }),
);
