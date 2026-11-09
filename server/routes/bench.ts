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
import { listDevices } from '../bench/hardware';
import { benchBinary } from '../bench/parse';
import type { BenchRunner } from '../bench/runner';
import type { BenchRunsRepo } from '../db/benchRuns';
import type { ProfilesRepo } from '../db/profiles';
import type { SettingsRepo } from '../db/settings';
import type { SweepsRepo } from '../db/sweeps';
import { guarded, HttpError, idParam, jsonObject, notFound } from '../http';
import { profilePaths } from '../supervisor/args';
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

  return {
    '/api/bench/runs': {
      GET: guarded((req) => {
        const q = new URL(req.url).searchParams;
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
          limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, 5000) : undefined,
        });
        return Response.json({ runs, live: benchRunner.live });
      }),
      DELETE: guarded((req) => {
        if (new URL(req.url).searchParams.get('failed') !== '1') throw new HttpError(400, '?failed=1 expected');
        const ids = benchRuns.deleteFailed();
        if (ids.length > 0) hub.broadcast({ type: 'bench-deleted', payload: { ids } });
        return Response.json({ deleted: ids.length });
      }),
    },
    '/api/bench/run': {
      POST: guarded(async (req) => {
        const body = await jsonObject(req);
        const spec = BenchSpecSchema.parse(body.spec);
        const run = await benchRunner.start(spec, { stopServer: body.stopServer === true });
        return Response.json(run, { status: 202 });
      }),
    },
    '/api/bench/devices': {
      GET: guarded(async () => Response.json(await listDevices(benchBinary(settings.get().binary)))),
    },
    '/api/bench/:id': {
      DELETE: guarded((req) => {
        const id = idParam(req, 'Run');
        const run = benchRuns.get(id);
        if (!run) throw notFound('Run');
        if (run.status === 'running') throw new HttpError(409, 'This run is still running: cancel it first');
        benchRuns.delete(id);
        hub.broadcast({ type: 'bench-deleted', payload: { ids: [id] } });
        return new Response(null, { status: 204 });
      }),
    },
    '/api/bench/from-profile/:id': {
      GET: guarded((req) => {
        const profile = profiles.get(idParam(req, 'Profile'));
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
        return Response.json(draft);
      }),
    },
    '/api/bench/:id/to-profile': {
      POST: guarded((req) => {
        const run = benchRuns.get(idParam(req, 'Run'));
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
        return Response.json(profile, { status: 201 });
      }),
    },
    '/api/bench/:id/cancel': {
      POST: guarded((req) => {
        const id = idParam(req, 'Run');
        if (!benchRunner.cancel(id)) throw new HttpError(409, 'This run is not running');
        return new Response(null, { status: 204 });
      }),
    },
  };
}
