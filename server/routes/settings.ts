import type { Settings } from '@llama-webui/shared';
import { Hono } from 'hono';
import type { SettingsRepo } from '../db/settings';
import { type Env, json, object } from '../http';
import type { Monitor } from '../monitor/monitor';

export interface SettingsRouteDeps {
  settings: Pick<SettingsRepo, 'get' | 'patch'>;
  monitor: Pick<Monitor, 'configure'>;
}

/** The settings after a patch, with a warning when the monitor could not apply them (one type for the client). */
type SettingsReply = Settings & { warning?: string };

export const settingsRoutes = ({ settings, monitor }: SettingsRouteDeps) =>
  new Hono<Env>()
    .get('/api/settings', (c) => c.json(settings.get()))
    .patch('/api/settings', json(object), async (c) => {
      const next = settings.patch(c.req.valid('json'));
      try {
        await monitor.configure(next);
      } catch (e) {
        // Saved all the same: a 500 would say the change was lost.
        const warning = `Saved, but the monitor could not apply it: ${e instanceof Error ? e.message : String(e)}`;
        console.error(`[llama-webui] ${warning}`);
        return c.json<SettingsReply>({ ...next, warning });
      }
      return c.json<SettingsReply>(next);
    });
