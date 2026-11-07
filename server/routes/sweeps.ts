import { type BenchSpec, rankRuns, SweepSpecSchema, sweepCtx } from '@llama-webui/shared';
import { z } from 'zod';
import { benchBinary } from '../bench/parse';
import type { BenchRunner } from '../bench/runner';
import type { BenchRunsRepo } from '../db/benchRuns';
import type { SettingsRepo } from '../db/settings';
import type { SweepsRepo } from '../db/sweeps';
import { guarded, HttpError, idParam, jsonObject, notFound } from '../http';
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
  const getSweep = (req: Parameters<typeof idParam>[0]) => {
    const sw = sweeps.get(idParam(req, 'Sweep'));
    if (!sw) throw notFound('Sweep');
    return sw;
  };
  const notRunning = (status: string) => {
    if (status === 'running') throw new HttpError(409, "Ce sweep tourne : annulez-le d'abord");
  };

  return {
    '/api/sweeps': {
      GET: guarded(() => Response.json({ sweeps: sweeps.list(), live: benchRunner.sweepLive })),
      POST: guarded(async (req) => {
        const body = await jsonObject(req);
        const spec = SweepSpecSchema.parse(body.spec);
        const [model, mmproj, hw] = await Promise.all([
          loadModel(spec.modelPath),
          mmprojBytes(spec.mmprojPath),
          readTuningHardware({
            benchBinary: benchBinary(settings.get().binary),
            mem: monitor.latest()?.system?.mem ?? null,
          }),
        ]);
        const plan = planSweep({ model, hw, spec, mmprojBytes: mmproj });
        if (plan.items.length === 0)
          throw new HttpError(
            409,
            `Aucune configuration à exécuter : ${plan.excluded} exclue${plan.excluded > 1 ? 's' : ''} par l'estimateur`,
          );
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
        return Response.json({ sweep, items: plan.items.length, excluded: plan.excluded }, { status: 202 });
      }),
    },
    '/api/sweeps/:id': {
      GET: guarded((req) => {
        const sweep = getSweep(req);
        return Response.json({ sweep, runs: benchRuns.list({ sweepId: sweep.id }) });
      }),
      DELETE: guarded((req) => {
        const sweep = getSweep(req);
        notRunning(sweep.status);
        const ids = sweeps.delete(sweep.id);
        hub.broadcast({ type: 'bench-deleted', payload: { ids } });
        hub.broadcast({ type: 'sweep-deleted', payload: { id: sweep.id } });
        return new Response(null, { status: 204 });
      }),
    },
    '/api/sweeps/:id/cancel': {
      POST: guarded((req) => {
        if (!benchRunner.cancelSweep(getSweep(req).id)) throw new HttpError(409, 'Ce sweep ne tourne pas');
        return new Response(null, { status: 204 });
      }),
    },
    '/api/sweeps/:id/resume': {
      POST: guarded(async (req) => {
        const sweep = getSweep(req);
        notRunning(sweep.status);
        const body = await jsonObject(req);
        const started = await benchRunner.startSweep(
          () => {
            benchRuns.requeueInterrupted(sweep.id);
            if (!benchRuns.nextQueued(sweep.id))
              throw new HttpError(409, 'Rien à reprendre : aucun élément interrompu ou en attente');
            return sweep.id;
          },
          { stopServer: body.stopServer === true },
        );
        return Response.json(started, { status: 202 });
      }),
    },
    '/api/sweeps/:id/validate': {
      POST: guarded(async (req) => {
        const sweep = getSweep(req);
        notRunning(sweep.status);
        const { n, stopServer } = ValidateRequest.parse(await jsonObject(req));
        const explored = benchRuns.list({ sweepId: sweep.id }).filter((r) => r.kind === 'bench');
        const best = rankRuns(explored, sweep.spec.preset, sweepCtx(sweep.spec))
          .filter((x) => x.rank !== null)
          .slice(0, n);
        if (best.length === 0) throw new HttpError(409, 'Aucun run réussi à valider');
        const { modelPath, mmprojPath, profileId, serverArgs, p, r } = sweep.spec;
        const started = await benchRunner.startSweep(
          () => {
            // Un sweep interrompu : ses éléments interrompus repartent avec la validation (sinon plus rien ne permet de les finir).
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
                  serverArgs,
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
          { stopServer: stopServer === true },
        );
        return Response.json(started, { status: 202 });
      }),
    },
  };
}
