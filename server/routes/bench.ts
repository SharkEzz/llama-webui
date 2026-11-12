import { homedir } from 'node:os';
import { basename } from 'node:path';
import {
  type BenchKind,
  type BenchSpec,
  BenchSpecSchema,
  type BenchStatus,
  paramsFromServerArgs,
  profileModelPath,
  serverArgs,
  sweepCtx,
  withCtx,
} from '@llama-webui/shared';
import { Hono } from 'hono';
import { benchBinary } from 'llamacpp-js/node';
import { listDevices } from '../bench/hardware';
import type { BenchRunner } from '../bench/runner';
import { type BenchRunsRepo, MAX_RUNS } from '../db/benchRuns';
import type { ProfilesRepo } from '../db/profiles';
import type { SettingsRepo } from '../db/settings';
import type { SweepsRepo } from '../db/sweeps';
import { type Env, HttpError, id, json, notFound, object, query } from '../http';
import { binaryPath, profilePaths } from '../supervisor/args';
import type { WsHub } from '../ws/hub';

export interface BenchRouteDeps {
  benchRuns: BenchRunsRepo;
  benchRunner: BenchRunner;
  settings: SettingsRepo;
  profiles: ProfilesRepo;
  sweeps: SweepsRepo;
  hub: WsHub;
}

const KINDS = new Set(['bench', 'server']);
const STATUSES = new Set(['queued', 'running', 'ok', 'failed', 'cancelled', 'interrupted']);

export function benchRoutes({ benchRuns, benchRunner, settings, profiles, sweeps, hub }: BenchRouteDeps) {
  const home = homedir();
  /** Free name: “<base>”, then “<base> (2)”, “(3)”… */
  const freeName = (base: string) => {
    const taken = new Set(profiles.list().map((p) => p.name));
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base} (${n})`;
    return name;
  };

  // Static paths before `/api/bench/:id` (Hono matches in registration order).
  return (
    new Hono<Env>()
      .get('/api/bench/runs', query('kind', 'status', 'sweep', 'limit', 'model'), (c) => {
        const q = new URL(c.req.url).searchParams;
        const kind = q.get('kind');
        const status = q.get('status');
        const sweep = q.get('sweep');
        const limit = Number(q.get('limit'));
        const runs = benchRuns.list({
          kind: kind && KINDS.has(kind) ? (kind as BenchKind) : undefined,
          status: status && STATUSES.has(status) ? (status as BenchStatus) : undefined,
          modelPath: q.get('model') || undefined,
          // By default: one-off runs only; “all” or a sweep id for the others.
          sweepId: sweep === 'all' ? 'all' : sweep && /^\d+$/.test(sweep) ? Number(sweep) : 'none',
          limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_RUNS) : undefined,
        });
        return c.json({ runs, live: benchRunner.live });
      })
      .delete('/api/bench/runs', query('failed'), (c) => {
        if (new URL(c.req.url).searchParams.get('failed') !== '1') throw new HttpError(400, '?failed=1 expected');
        const ids = benchRuns.deleteFailed();
        if (ids.length > 0) hub.broadcast({ type: 'bench-deleted', payload: { ids } });
        return c.json({ deleted: ids.length });
      })
      // The spec is a field of the body: its errors keep their paths (`kind`, not `spec.kind`).
      .post('/api/bench/run', json(object), async (c) => {
        const body = c.req.valid('json');
        const spec = BenchSpecSchema.parse(body.spec);
        const run = await benchRunner.start(spec, { stopServer: body.stopServer === true });
        return c.json(run, 202);
      })
      .get('/api/bench/devices', async (c) => c.json(await listDevices(benchBinary(binaryPath(settings.get())))))
      .get('/api/bench/from-profile/:id', id('Profile'), (c) => {
        const profile = profiles.get(c.req.valid('param').id);
        if (!profile) throw notFound('Profile');
        const paths = profilePaths(profile, home);
        const { params, rest } = paramsFromServerArgs(profile.args);
        const draft: Pick<BenchSpec, 'modelPath' | 'mmprojPath' | 'profileId' | 'params' | 'serverArgs'> = {
          modelPath: paths.model,
          mmprojPath: paths.mmproj,
          profileId: profile.id,
          params,
          serverArgs: rest,
        };
        return c.json(draft);
      })
      .delete('/api/bench/:id', id('Run'), (c) => {
        const { id } = c.req.valid('param');
        const run = benchRuns.get(id);
        if (!run) throw notFound('Run');
        if (run.status === 'running') throw new HttpError(409, 'This run is still running: cancel it first');
        benchRuns.delete(id);
        hub.broadcast({ type: 'bench-deleted', payload: { ids: [id] } });
        return c.body(null, 204);
      })
      .post('/api/bench/:id/to-profile', id('Run'), (c) => {
        const run = benchRuns.get(c.req.valid('param').id);
        if (!run) throw notFound('Run');
        if (run.status === 'running') throw new HttpError(409, 'This run is still running');
        const { spec } = run;
        const modelsDir = settings.get().modelsDir;
        const placed = profileModelPath(spec.modelPath, { modelsDir, home });
        const mmproj = spec.mmprojPath
          ? profileModelPath(spec.mmprojPath, { cwd: placed.cwd, modelsDir, home }).model
          : undefined;
        const origin = spec.profileId !== null ? profiles.get(spec.profileId) : null;
        // A sweep run: the context it was planned at, not the model's full one (#24).
        const sweep = run.sweepId !== null ? sweeps.get(run.sweepId) : null;
        const profile = profiles.create({
          name: freeName(`${basename(spec.modelPath).replace(/\.gguf$/, '')} — bench #${run.id}`),
          model: placed.model,
          ...(mmproj ? { mmproj } : {}),
          ...(placed.cwd ? { cwd: placed.cwd } : {}),
          args: [...serverArgs(spec.params), ...withCtx(spec.serverArgs, sweep ? sweepCtx(sweep.spec) : null)],
          env: origin?.env ?? {},
        });
        return c.json(profile, 201);
      })
      .post('/api/bench/:id/cancel', id('Run'), (c) => {
        if (!benchRunner.cancel(c.req.valid('param').id)) throw new HttpError(409, 'This run is not running');
        return c.body(null, 204);
      })
  );
}
