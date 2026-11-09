import type { Database } from 'bun:sqlite';
import { isLoopback } from '@llama-webui/shared';
import { buildOf, listDevices } from '../bench/hardware';
import { benchBinary } from '../bench/parse';
import type { BenchRunsRepo } from '../db/benchRuns';
import { ModelCacheRepo } from '../db/modelCache';
import type { ProfilesRepo } from '../db/profiles';
import type { SettingsRepo } from '../db/settings';
import { guarded } from '../http';
import { scanModels } from '../models/scan';
import type { Monitor } from '../monitor/monitor';
import { buildLaunchpad, buildSetupReport, readPerfParanoid } from '../setup';
import { expandHome, profilePaths } from '../supervisor/args';
import { estimate } from '../tuning/estimate';
import { readTuningHardware } from '../tuning/hardware';
import { loadModel, mmprojBytes } from '../tuning/models';
import { resolveBinary } from '../tuning/sysinfo';

export interface SetupRouteDeps {
  db: Database;
  settings: SettingsRepo;
  profiles: ProfilesRepo;
  benchRuns: BenchRunsRepo;
  monitor: Monitor;
  /** Address llama-webui listens on. */
  hostname: string;
}

export function setupRoutes({ db, settings, profiles, benchRuns, monitor, hostname }: SetupRouteDeps) {
  const cache = new ModelCacheRepo(db);

  return {
    '/api/setup': {
      GET: guarded(async () => {
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
        return Response.json(report);
      }),
    },
    '/api/launchpad': {
      GET: guarded(async () => {
        const s = settings.get();
        // Read once for every profile (llama-bench --list-devices is cached anyway).
        const hw = readTuningHardware({
          benchBinary: benchBinary(s.binary),
          mem: monitor.latest()?.system?.mem ?? null,
          gpus: monitor.latest()?.allGpus,
        });
        const entries = await buildLaunchpad(profiles.list(), {
          paths: (p) => profilePaths(p),
          loadModel,
          mmprojBytes,
          estimate: async (input) => {
            const h = await hw;
            // llama-bench missing while GPUs exist: an estimate without them would be wrong, so no fit badge.
            if (h.devices.length === 0 && (monitor.latest()?.allGpus.length ?? 0) > 0)
              throw new Error('GPUs unknown to llama-bench');
            return estimate({ ...input, hw: h, preset: 'fit' });
          },
          lastBench: benchRuns.lastOkByProfile(),
        });
        return Response.json(entries);
      }),
    },
  };
}
