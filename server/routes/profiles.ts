import { parseProfileImport } from '@llama-webui/shared';
import type { ProfilesRepo } from '../db/profiles';
import { toInput } from '../db/profiles';
import type { SettingsRepo } from '../db/settings';
import { guarded, HttpError, idParam, notFound } from '../http';
import { readLlamaTuiProfiles } from '../llamatui';

export interface ProfileRouteDeps {
  profiles: ProfilesRepo;
  settings: SettingsRepo;
  /** Profil du serveur en cours (on ne le supprime pas sous ses pieds). */
  activeProfileId: () => number | null;
}

function attachment(filename: string, body: unknown): Response {
  return new Response(`${JSON.stringify(body, null, 2)}\n`, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    },
  });
}

export function profileRoutes({ profiles, settings, activeProfileId }: ProfileRouteDeps) {
  const mustGet = (id: number) =>
    profiles.get(id) ??
    (() => {
      throw notFound('Profil');
    })();

  return {
    '/api/profiles': {
      GET: guarded(() => Response.json(profiles.list())),
      POST: guarded(async (req) => Response.json(profiles.create(await req.json()), { status: 201 })),
    },
    '/api/profiles/export': {
      GET: guarded(() => attachment('llama-webui-profils.json', { profiles: profiles.list().map(toInput) })),
    },
    '/api/profiles/import': {
      POST: guarded(async (req) => {
        const parsed = parseProfileImport(await req.json());
        const { imported, skipped } = profiles.importMany(parsed.profiles, 'import');
        return Response.json({ imported, skipped: [...parsed.rejected, ...skipped] });
      }),
    },
    '/api/profiles/import/llama-tui': {
      GET: guarded(async () => {
        const cfg = await readLlamaTuiProfiles();
        return Response.json({
          path: cfg.path,
          exists: cfg.exists,
          names: cfg.profiles.map((p) => p.name),
          error: cfg.error,
          dismissed: settings.get().llamaTuiImportDismissed,
          profileCount: profiles.count(),
        });
      }),
      POST: guarded(async () => {
        const cfg = await readLlamaTuiProfiles();
        if (!cfg.exists) throw new HttpError(404, `Config llama-tui introuvable (${cfg.path})`);
        if (cfg.error) throw new HttpError(400, `Config llama-tui illisible : ${cfg.error}`);
        const { imported, skipped } = profiles.importMany(cfg.profiles, 'llama-tui');
        if (settings.get().defaultProfileId === null && cfg.defaultProfile) {
          const def = profiles.list().find((p) => p.name === cfg.defaultProfile);
          if (def) settings.patch({ defaultProfileId: def.id });
        }
        return Response.json({ imported, skipped: [...cfg.rejected, ...skipped] });
      }),
    },
    '/api/profiles/:id': {
      GET: guarded((req) => Response.json(mustGet(idParam(req, 'Profil')))),
      PUT: guarded(async (req) => Response.json(profiles.update(idParam(req, 'Profil'), await req.json()))),
      DELETE: guarded((req) => {
        const id = idParam(req, 'Profil');
        if (activeProfileId() === id)
          throw new HttpError(409, "Ce profil est celui du serveur en cours : arrêtez-le d'abord");
        profiles.remove(id);
        if (settings.get().defaultProfileId === id) settings.patch({ defaultProfileId: null });
        return new Response(null, { status: 204 });
      }),
    },
    '/api/profiles/:id/duplicate': {
      POST: guarded((req) => Response.json(profiles.duplicate(idParam(req, 'Profil')), { status: 201 })),
    },
    '/api/profiles/:id/export': {
      GET: guarded((req) => {
        const p = mustGet(idParam(req, 'Profil'));
        return attachment(`${p.name}.json`, toInput(p));
      }),
    },
  };
}
