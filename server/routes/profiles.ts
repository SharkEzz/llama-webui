import { type ProfileInputSchema, parseProfileImport } from '@llama-webui/shared';
import { type Context, Hono } from 'hono';
import type { z } from 'zod';
import type { ProfilesRepo } from '../db/profiles';
import { toInput } from '../db/profiles';
import type { SettingsRepo } from '../db/settings';
import { accepts, type Env, HttpError, id, json, notFound, passthrough } from '../http';
import { readLlamaTuiProfiles } from '../llamatui';

export interface ProfileRouteDeps {
  profiles: ProfilesRepo;
  settings: SettingsRepo;
  /** Profile of the running server (not deleted from under its feet). */
  activeProfileId: () => number | null;
}

/** Deletes a profile: refused for the running server's, and no longer the default one. */
export function removeProfile({ profiles, settings, activeProfileId }: ProfileRouteDeps, id: number): void {
  if (activeProfileId() === id) throw new HttpError(409, 'This profile belongs to the running server: stop it first');
  profiles.remove(id);
  if (settings.get().defaultProfileId === id) settings.patch({ defaultProfileId: null });
}

/** A JSON download, indented for a person to read. */
const attachment = (c: Context<Env>, filename: string, body: unknown) =>
  c.body(`${JSON.stringify(body, null, 2)}\n`, 200, {
    'content-type': 'application/json',
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
  });

export function profileRoutes(deps: ProfileRouteDeps) {
  const { profiles, settings } = deps;
  const mustGet = (id: number) =>
    profiles.get(id) ??
    (() => {
      throw notFound('Profile');
    })();

  // Static paths before `/api/profiles/:id` (Hono matches in registration order).
  return (
    new Hono<Env>()
      .get('/api/profiles', (c) => c.json(profiles.list()))
      // The repo validates (one parse of the schema, as for an import): the body is only declared here.
      .post('/api/profiles', accepts<z.input<typeof ProfileInputSchema>>(), async (c) =>
        c.json(profiles.create(await c.req.json()), 201),
      )
      .get('/api/profiles/export', (c) =>
        attachment(c, 'llama-webui-profiles.json', { profiles: profiles.list().map(toInput) }),
      )
      .post('/api/profiles/import', json(passthrough), (c) => {
        const parsed = parseProfileImport(c.req.valid('json'));
        const { imported, skipped } = profiles.importMany(parsed.profiles, 'import');
        return c.json({ imported, skipped: [...parsed.rejected, ...skipped] });
      })
      .get('/api/profiles/import/llama-tui', async (c) => {
        const cfg = await readLlamaTuiProfiles();
        return c.json({
          path: cfg.path,
          exists: cfg.exists,
          names: cfg.profiles.map((p) => p.name),
          error: cfg.error,
          dismissed: settings.get().llamaTuiImportDismissed,
          profileCount: profiles.count(),
        });
      })
      .post('/api/profiles/import/llama-tui', async (c) => {
        const cfg = await readLlamaTuiProfiles();
        if (!cfg.exists) throw new HttpError(404, `llama-tui config not found (${cfg.path})`);
        if (cfg.error) throw new HttpError(400, `Unreadable llama-tui config: ${cfg.error}`);
        const { imported, skipped } = profiles.importMany(cfg.profiles, 'llama-tui');
        if (settings.get().defaultProfileId === null && cfg.defaultProfile) {
          const def = profiles.list().find((p) => p.name === cfg.defaultProfile);
          if (def) settings.patch({ defaultProfileId: def.id });
        }
        return c.json({ imported, skipped: [...cfg.rejected, ...skipped] });
      })
      .get('/api/profiles/:id', id('Profile'), (c) => c.json(mustGet(c.req.valid('param').id)))
      // The repo looks the profile up before parsing the body (404 beats 400): the body is passed as sent.
      .put('/api/profiles/:id', id('Profile'), json(passthrough), (c) =>
        c.json(profiles.update(c.req.valid('param').id, c.req.valid('json'))),
      )
      .delete('/api/profiles/:id', id('Profile'), (c) => {
        removeProfile(deps, c.req.valid('param').id);
        return c.body(null, 204);
      })
      .post('/api/profiles/:id/duplicate', id('Profile'), (c) =>
        c.json(profiles.duplicate(c.req.valid('param').id), 201),
      )
      .get('/api/profiles/:id/export', id('Profile'), (c) => {
        const p = mustGet(c.req.valid('param').id);
        return attachment(c, `${p.name}.json`, toInput(p));
      })
  );
}
