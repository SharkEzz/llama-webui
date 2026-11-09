import type { SettingsRepo } from '../db/settings';
import { guarded, jsonObject } from '../http';
import type { Monitor } from '../monitor/monitor';

export interface SettingsRouteDeps {
  settings: Pick<SettingsRepo, 'get' | 'patch'>;
  monitor: Pick<Monitor, 'configure'>;
}

export function settingsRoutes({ settings, monitor }: SettingsRouteDeps) {
  return {
    '/api/settings': {
      GET: guarded(() => Response.json(settings.get())),
      PATCH: guarded(async (req) => {
        const next = settings.patch(await jsonObject(req));
        try {
          await monitor.configure(next);
        } catch (e) {
          // Saved all the same: a 500 would say the change was lost.
          const warning = `Saved, but the monitor could not apply it: ${e instanceof Error ? e.message : String(e)}`;
          console.error(`[llama-webui] ${warning}`);
          return Response.json({ ...next, warning });
        }
        return Response.json(next);
      }),
    },
  };
}
