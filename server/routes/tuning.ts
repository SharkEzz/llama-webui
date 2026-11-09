import {
  BenchParamsSchema,
  type ChecksReport,
  type DiskSpeed,
  type Estimate,
  PRESET_IDS,
  SweepSpecSchema,
} from '@llama-webui/shared';
import { z } from 'zod';
import { benchBinary } from '../bench/parse';
import type { BenchRunner } from '../bench/runner';
import type { SettingsRepo } from '../db/settings';
import { guarded, HttpError, jsonObject } from '../http';
import type { Monitor } from '../monitor/monitor';
import type { Runtime } from '../runtime';
import { binaryPath } from '../supervisor/args';
import { runChecks, summarize } from '../tuning/checks';
import { measureDiskSpeed } from '../tuning/disk';
import { estimate } from '../tuning/estimate';
import { readTuningHardware } from '../tuning/hardware';
import { retainedBusIds } from '../tuning/match';
import { loadModel, mmprojBytes } from '../tuning/models';
import { planSweep } from '../tuning/space';
import { readSys } from '../tuning/sysinfo';

export interface TuningRouteDeps {
  settings: SettingsRepo;
  monitor: Monitor;
  benchRunner: BenchRunner;
  runtime: Runtime;
}

const EstimateRequest = z.strictObject({
  modelPath: z.string().min(1),
  mmprojPath: z.string().nullish(),
  preset: z.enum(PRESET_IDS),
  pinned: BenchParamsSchema.optional(),
  ctx: z.number().int().min(512).max(10_000_000).optional(),
});

/** Latest disk measurements and estimates, per model (in memory: lost on reload, which is harmless). */
const diskSpeeds = new Map<string, DiskSpeed>();
const lastEstimates = new Map<string, Estimate>();

export function tuningRoutes({ settings, monitor, benchRunner, runtime }: TuningRouteDeps) {
  const hardware = () =>
    readTuningHardware({
      benchBinary: benchBinary(settings.get().binary),
      mem: monitor.latest()?.system?.mem ?? null,
      gpus: monitor.latest()?.allGpus,
    });

  return {
    '/api/tuning/hardware': {
      GET: guarded(async () => Response.json(await hardware())),
    },
    '/api/tuning/estimate': {
      POST: guarded(async (req) => {
        const body = EstimateRequest.parse(await jsonObject(req));
        const [model, mmproj, hw] = await Promise.all([
          loadModel(body.modelPath),
          mmprojBytes(body.mmprojPath),
          hardware(),
        ]);
        const e = estimate({ model, hw, preset: body.preset, mmprojBytes: mmproj, pinned: body.pinned, ctx: body.ctx });
        lastEstimates.set(body.modelPath, e);
        return Response.json(e);
      }),
    },
    '/api/tuning/plan': {
      POST: guarded(async (req) => {
        const spec = SweepSpecSchema.parse((await jsonObject(req)).spec);
        const [model, mmproj, hw] = await Promise.all([
          loadModel(spec.modelPath),
          mmprojBytes(spec.mmprojPath),
          hardware(),
        ]);
        return Response.json(planSweep({ model, hw, spec, mmprojBytes: mmproj }));
      }),
    },
    '/api/tuning/checks': {
      GET: guarded(async (req) => {
        const modelPath = new URL(req.url).searchParams.get('model') || null;
        const snap = monitor.latest();
        const gpus = snap?.allGpus ?? [];
        const [hw, model, readings] = await Promise.all([
          hardware(),
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
        return Response.json(report);
      }),
    },
    '/api/tuning/disk-speed': {
      POST: guarded(async (req) => {
        const { modelPath } = z.strictObject({ modelPath: z.string().min(1) }).parse(await jsonObject(req));
        if (benchRunner.busy) throw new HttpError(409, 'A benchmark is running: the measurement would be skewed');
        await loadModel(modelPath);
        const d = await measureDiskSpeed(modelPath);
        diskSpeeds.set(modelPath, d);
        return Response.json(d);
      }),
    },
  };
}
