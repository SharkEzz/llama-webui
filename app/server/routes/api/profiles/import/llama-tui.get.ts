import { defineHandler } from 'nitro';
import { deps } from '../../../../lib/context.ts';
import { reply } from '../../../../lib/http.ts';
import { readLlamaTuiProfiles } from '../../../../lib/llamatui.ts';

export default defineHandler(async () => {
  const { profiles, settings } = deps();
  const cfg = await readLlamaTuiProfiles();
  return reply({
    path: cfg.path,
    exists: cfg.exists,
    names: cfg.profiles.map((p) => p.name),
    error: cfg.error,
    dismissed: settings.get().llamaTuiImportDismissed,
    profileCount: profiles.count(),
  });
});
