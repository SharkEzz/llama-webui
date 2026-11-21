import type { ChecksReport } from '@llama-webui/shared';
import { defineHandler } from 'nitro';
import { deps } from '../../../lib/context.ts';
import { type QueryOf, queryOf, reply } from '../../../lib/http.ts';
import { binaryPath } from '../../../lib/supervisor/args.ts';
import { runChecks, summarize } from '../../../lib/tuning/checks.ts';
import { retainedBusIds } from '../../../lib/tuning/match.ts';
import { diskSpeeds, lastEstimates, tuningHardware } from '../../../lib/tuning/memo.ts';
import { loadModel } from '../../../lib/tuning/models.ts';
import { readSys } from '../../../lib/tuning/sysinfo.ts';

export type Query = QueryOf<'model'>;

export default defineHandler(async (event) => {
  const d = deps();
  const { monitor, settings, runtime } = d;
  const modelPath = queryOf(event, 'model').model || null;
  const snap = monitor.latest();
  const gpus = snap?.allGpus ?? [];
  const [hw, model, readings] = await Promise.all([
    tuningHardware(d),
    modelPath ? loadModel(modelPath).catch(() => null) : Promise.resolve(null),
    readSys({
      binary: binaryPath(settings.get()),
      modelPath,
      logLines: () => runtime.logs.since(0),
      nvml: monitor.nvmlSystem,
      busIds: gpus.map((g) => g.busId),
    }),
  ]);
  const last = modelPath ? (lastEstimates.get(modelPath) ?? null) : null;
  const checks = runChecks({
    readings,
    gpus,
    // Only the cards the estimate runs on: the others are `na` (#36).
    retainedBusIds: retainedBusIds(hw.devices, gpus, last?.params.dev),
    devices: hw.devices,
    cpu: hw.cpu,
    model,
    estimate: last,
    mem: snap?.system?.mem ?? null,
    diskSpeed: modelPath ? (diskSpeeds.get(modelPath) ?? null) : null,
    now: Date.now(),
  });
  const report: ChecksReport = { checks, summary: summarize(checks), at: Date.now() };
  return reply(report);
});
