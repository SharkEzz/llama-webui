import { defineHandler } from 'nitro';
import { deps } from '../../../../lib/context.ts';
import { HttpError, reply } from '../../../../lib/http.ts';
import { readLlamaTuiProfiles } from '../../../../lib/llamatui.ts';

export default defineHandler(async () => {
  const { profiles, settings } = deps();
  const cfg = await readLlamaTuiProfiles();
  if (!cfg.exists) throw new HttpError(404, `llama-tui config not found (${cfg.path})`);
  if (cfg.error) throw new HttpError(400, `Unreadable llama-tui config: ${cfg.error}`);
  const { imported, skipped } = profiles.importMany(cfg.profiles, 'llama-tui');
  if (settings.get().defaultProfileId === null && cfg.defaultProfile) {
    const def = profiles.list().find((p) => p.name === cfg.defaultProfile);
    if (def) settings.patch({ defaultProfileId: def.id });
  }
  return reply({ imported, skipped: [...cfg.rejected, ...skipped] });
});
