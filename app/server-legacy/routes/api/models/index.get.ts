import { homedir } from 'node:os';
import type { ModelList } from '@llama-webui/shared';
import { defineHandler } from 'nitro';
import { deps } from '../../../lib/context.ts';
import { ModelCacheRepo } from '../../../lib/db/modelCache.ts';
import { reply } from '../../../lib/http.ts';
import { modelsDir } from '../../../lib/models/access.ts';
import { scanModels } from '../../../lib/models/scan.ts';

export default defineHandler(async () => {
  const d = deps();
  const { setting, dir } = modelsDir(d);
  const list: ModelList = {
    dir,
    setting,
    home: homedir(),
    scannedAt: Date.now(),
    models: await scanModels(dir, { cache: new ModelCacheRepo(d.db) }),
  };
  return reply(list);
});
