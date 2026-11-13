import {
  BenchParamsSchema,
  type ChecksReport,
  type DiskSpeed,
  type Estimate,
  PRESET_IDS,
  SweepSpecSchema,
} from '@llama-webui/shared';
import { Hono } from 'hono';
import { benchBinary } from 'llamacpp-js/node';
import { z } from 'zod';
import type { BenchRunner } from '../bench/runner';
import type { SettingsRepo } from '../db/settings';
import { body, type Env, HttpError, json, object, query } from '../http';
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

/** Latest disk measurements and estimates, per model (in memory: lost on restart, which is harmless). */
const DiskSpeedRequest = z.strictObject({ modelPath: z.string().min(1) });

const diskSpeeds = new Map<string, DiskSpeed>();
const lastEstimates = new Map<string, Estimate>();

export function tuningRoutes({ settings, monitor, benchRunner, runtime }: TuningRouteDeps) {
  const hardware = () =>
    readTuningHardware({
      benchBinary: benchBinary(settings.get().binary),
      mem: monitor.latest()?.system?.mem ?? null,
      gpus: monitor.latest()?.allGpus,
    });

  return (
    new Hono<Env>()
      .get('/api/tuning/hardware', async (c) => c.json(await hardware()))
      .post('/api/tuning/estimate', body(EstimateRequest), async (c) => {
        const body = c.req.valid('json');
        const [model, mmproj, hw] = await Promise.all([
          loadModel(body.modelPath),
          mmprojBytes(body.mmprojPath),
          hardware(),
        ]);
        const e = estimate({ model, hw, preset: body.preset, mmprojBytes: mmproj, pinned: body.pinned, ctx: body.ctx });
        lastEstimates.set(body.modelPath, e);
        return c.json(e);
      })
      // The spec is a field of the body: its errors keep their paths (`modelPath`, not `spec.modelPath`).
      .post('/api/tuning/plan', json(object), async (c) => {
        const spec = SweepSpecSchema.parse(c.req.valid('json').spec);
        const [model, mmproj, hw] = await Promise.all([
          loadModel(spec.modelPath),
          mmprojBytes(spec.mmprojPath),
          hardware(),
        ]);
        return c.json(planSweep({ model, hw, spec, mmprojBytes: mmproj }));
      })
      .get('/api/tuning/checks', query('model'), async (c) => {
        const modelPath = c.req.valid('query').model || null;
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
        return c.json(report);
      })
      .post('/api/tuning/disk-speed', body(DiskSpeedRequest), async (c) => {
        const { modelPath } = c.req.valid('json');
        if (benchRunner.busy) throw new HttpError(409, 'A benchmark is running: the measurement would be skewed');
        await loadModel(modelPath);
        const d = await measureDiskSpeed(modelPath);
        diskSpeeds.set(modelPath, d);
        return c.json(d);
      })
  );
}
