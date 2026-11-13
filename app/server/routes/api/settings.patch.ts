import type { Settings } from '@llama-webui/shared';
import { defineHandler } from 'nitro';
import { deps } from '../../lib/context.ts';
import { object, readJson, reply } from '../../lib/http.ts';

export type Body = Record<string, unknown>;

/** The settings after a patch, with a warning when the monitor could not apply them (one type for the client). */
type SettingsReply = Settings & { warning?: string };

export default defineHandler(async (event) => {
  const { settings, monitor } = deps();
  const next = settings.patch(await readJson(event, object));
  try {
    await monitor.configure(next);
  } catch (e) {
    // Saved all the same: a 500 would say the change was lost.
    const warning = `Saved, but the monitor could not apply it: ${e instanceof Error ? e.message : String(e)}`;
    console.error(`[llama-webui] ${warning}`);
    return reply<SettingsReply>({ ...next, warning });
  }
  return reply<SettingsReply>(next);
});
