import { type BenchSpec, rankRuns, SweepSpecSchema, sweepCtx, withCtx } from '@llama-webui/shared';
import { Hono } from 'hono';
import { benchBinary } from 'llamacpp-js/node';
import { z } from 'zod';
import type { BenchRunner } from '../bench/runner';
import type { BenchRunsRepo } from '../db/benchRuns';
import type { SettingsRepo } from '../db/settings';
import type { SweepsRepo } from '../db/sweeps';
import { accepts, type Env, HttpError, id, json, notFound, object } from '../http';
import type { Monitor } from '../monitor/monitor';
import { readTuningHardware } from '../tuning/hardware';
import { loadModel, mmprojBytes } from '../tuning/models';
import { planSweep } from '../tuning/space';
import type { WsHub } from '../ws/hub';

export interface SweepRouteDeps {
  sweeps: SweepsRepo;
  benchRuns: BenchRunsRepo;
  benchRunner: BenchRunner;
  settings: SettingsRepo;
  monitor: Monitor;
  hub: WsHub;
}

const ValidateRequest = z.strictObject({
  n: z.number().int().min(1).max(5).default(3),
  stopServer: z.boolean().optional(),
});

export function sweepRoutes({ sweeps, benchRuns, benchRunner, settings, monitor, hub }: SweepRouteDeps) {
  const getSweep = (id: number) => {
    const sw = sweeps.get(id);
    if (!sw) throw notFound('Sweep');
    return sw;
  };
  const notRunning = (status: string) => {
    if (status === 'running') throw new HttpError(409, 'This sweep is still running: cancel it first');
  };

  return (
    new Hono<Env>()
      .get('/api/sweeps', (c) => c.json({ sweeps: sweeps.list(), live: benchRunner.sweepLive }))
      // The spec is a field of the body: its errors keep their paths (`modelPath`, not `spec.modelPath`).
      .post('/api/sweeps', json(object), async (c) => {
        const body = c.req.valid('json');
        const spec = SweepSpecSchema.parse(body.spec);
        const [model, mmproj, hw] = await Promise.all([
          loadModel(spec.modelPath),
          mmprojBytes(spec.mmprojPath),
          readTuningHardware({
            benchBinary: benchBinary(settings.get().binary),
            mem: monitor.latest()?.system?.mem ?? null,
            gpus: monitor.latest()?.allGpus,
          }),
        ]);
        const plan = planSweep({ model, hw, spec, mmprojBytes: mmproj });
        if (plan.items.length === 0)
          throw new HttpError(409, `No configuration to run: ${plan.excluded} excluded by the estimator`);
        const { modelPath, mmprojPath, profileId, serverArgs, p, n, r } = spec;
        const sweep = await benchRunner.startSweep(
          () => {
            const s = sweeps.create(spec);
            benchRuns.enqueue(
              s.id,
              plan.items.map((it) => ({
                spec: {
                  kind: 'bench',
                  modelPath,
                  mmprojPath,
                  profileId,
                  params: it.params,
                  serverArgs,
                  p,
                  n,
                  r,
                } satisfies BenchSpec,
                label: it.label,
                fit: it.fit.verdict,
              })),
            );
            return s.id;
          },
          { stopServer: body.stopServer === true },
        );
        return c.json({ sweep, items: plan.items.length, excluded: plan.excluded }, 202);
      })
      .get('/api/sweeps/:id', id('Sweep'), (c) => {
        const sweep = getSweep(c.req.valid('param').id);
        return c.json({ sweep, runs: benchRuns.list({ sweepId: sweep.id }) });
      })
      .delete('/api/sweeps/:id', id('Sweep'), (c) => {
        const sweep = getSweep(c.req.valid('param').id);
        notRunning(sweep.status);
        const ids = sweeps.delete(sweep.id);
        hub.broadcast({ type: 'bench-deleted', payload: { ids } });
        hub.broadcast({ type: 'sweep-deleted', payload: { id: sweep.id } });
        return c.body(null, 204);
      })
      .post('/api/sweeps/:id/cancel', id('Sweep'), (c) => {
        if (!benchRunner.cancelSweep(getSweep(c.req.valid('param').id).id))
          throw new HttpError(409, 'This sweep is not running');
        return c.body(null, 204);
      })
      // resume and validate look the sweep up (404, 409) before reading the body: no body validator, read here.
      .post('/api/sweeps/:id/resume', id('Sweep'), accepts<{ stopServer?: boolean }>(), async (c) => {
        const sweep = getSweep(c.req.valid('param').id);
        notRunning(sweep.status);
        const body = object(await c.req.json());
        const started = await benchRunner.startSweep(
          () => {
            benchRuns.requeueInterrupted(sweep.id);
            if (!benchRuns.nextQueued(sweep.id))
              throw new HttpError(409, 'Nothing to resume: no interrupted or queued item');
            return sweep.id;
          },
          { stopServer: body.stopServer === true, files: sweep.spec },
        );
        return c.json(started, 202);
      })
      .post('/api/sweeps/:id/validate', id('Sweep'), accepts<z.input<typeof ValidateRequest>>(), async (c) => {
        const sweep = getSweep(c.req.valid('param').id);
        notRunning(sweep.status);
        const { n, stopServer } = ValidateRequest.parse(object(await c.req.json()));
        const explored = benchRuns.list({ sweepId: sweep.id }).filter((r) => r.kind === 'bench');
        const best = rankRuns(explored, sweep.spec.preset, sweepCtx(sweep.spec))
          .filter((x) => x.rank !== null)
          .slice(0, n);
        if (best.length === 0) throw new HttpError(409, 'No successful run to validate');
        const { modelPath, mmprojPath, profileId, serverArgs, p, r } = sweep.spec;
        const started = await benchRunner.startSweep(
          () => {
            // An interrupted sweep: its interrupted items are requeued with the validation (otherwise nothing could finish them).
            benchRuns.requeueInterrupted(sweep.id);
            benchRuns.enqueue(
              sweep.id,
              best.map(({ run }) => ({
                spec: {
                  kind: 'server',
                  modelPath,
                  mmprojPath,
                  profileId,
                  params: run.spec.params,
                  // The context the sweep was planned at, not the model's full one (#24).
                  serverArgs: withCtx(serverArgs, sweepCtx(sweep.spec)),
                  p,
                  n: sweep.spec.n,
                  r,
                } satisfies BenchSpec,
                label: `validation · ${run.sweepLabel ?? 'base'}`,
                fit: run.fit ?? 'fits',
              })),
            );
            return sweep.id;
          },
          { stopServer: stopServer === true, files: sweep.spec },
        );
        return c.json(started, 202);
      })
  );
}
