import { isLoopback } from '@llama-webui/shared';
import { Hono } from 'hono';
import { benchBinary } from 'llamacpp-js/node';
import { buildOf, listDevices } from '../bench/hardware';
import type { BenchRunsRepo } from '../db/benchRuns';
import { ModelCacheRepo } from '../db/modelCache';
import type { ProfilesRepo } from '../db/profiles';
import type { SettingsRepo } from '../db/settings';
import type { Database } from '../db/sqlite';
import type { Env } from '../http';
import { scanModels } from '../models/scan';
import type { Monitor } from '../monitor/monitor';
import { buildLaunchpad, buildSetupReport, readPerfParanoid } from '../setup';
import { binaryPath, expandHome, profilePaths } from '../supervisor/args';
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

  return new Hono<Env>()
    .get('/api/setup', async (c) => {
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
      return c.json(report);
    })
    .get('/api/launchpad', async (c) => {
      const s = settings.get();
      // Read once for every profile (llama-bench --list-devices is cached anyway).
      const hw = readTuningHardware({
        benchBinary: benchBinary(binaryPath(s)),
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
      return c.json(entries);
    });
}
