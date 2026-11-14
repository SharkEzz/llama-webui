import { isLoopback } from '@llama-webui/shared';
import { benchBinary } from 'llamacpp-js/node';
import { defineHandler } from 'nitro';
import { buildOf, listDevices } from '../../lib/bench/hardware.ts';
import { deps } from '../../lib/context.ts';
import { ModelCacheRepo } from '../../lib/db/modelCache.ts';
import { reply } from '../../lib/http.ts';
import { scanModels } from '../../lib/models/scan.ts';
import { buildSetupReport, readPerfParanoid } from '../../lib/setup.ts';
import { expandHome } from '../../lib/supervisor/args.ts';
import { resolveBinary } from '../../lib/tuning/sysinfo.ts';

export default defineHandler(async () => {
  const { db, settings, monitor, hostname } = deps();
  const cache = new ModelCacheRepo(db);
  const s = settings.get();
  const report = await buildSetupReport({
    settings: s,
    modelsDir: expandHome(s.modelsDir),
    resolveBinary,
    buildOf,
    benchBinary,
    listDevices,
    scanModels: (dir) => scanModels(dir, { cache }),
    nvidiaSource: monitor.nvidiaSource,
    readPerfParanoid: () => readPerfParanoid(),
    listen: { host: hostname, exposed: !isLoopback(hostname) },
  });
  return reply(report);
});
