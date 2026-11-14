import { benchBinary } from 'llamacpp-js/node';
import { defineHandler } from 'nitro';
import { deps } from '../../lib/context.ts';
import { reply } from '../../lib/http.ts';
import { buildLaunchpad } from '../../lib/setup.ts';
import { binaryPath, profilePaths } from '../../lib/supervisor/args.ts';
import { estimate } from '../../lib/tuning/estimate.ts';
import { readTuningHardware } from '../../lib/tuning/hardware.ts';
import { loadModel, mmprojBytes } from '../../lib/tuning/models.ts';

export default defineHandler(async () => {
  const { settings, profiles, benchRuns, monitor } = deps();
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
  return reply(entries);
});
