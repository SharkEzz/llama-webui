import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { type ModelDeleted, ModelDeleteSchema, type ModelDetail, type ModelList } from '@llama-webui/shared';
import type { BenchRunner } from '../bench/runner';
import type { BenchRunsRepo } from '../db/benchRuns';
import type { DownloadsRepo } from '../db/downloads';
import { ModelCacheRepo } from '../db/modelCache';
import type { ProfilesRepo } from '../db/profiles';
import type { SettingsRepo } from '../db/settings';
import type { Database } from '../db/sqlite';
import type { SweepsRepo } from '../db/sweeps';
import { guarded, HttpError, jsonObject, notFound } from '../http';
import { deleteModelFiles, findEntry, type ModelUsers, modelUsage } from '../models/delete';
import { readModel } from '../models/gguf';
import { scanModels, toSummary } from '../models/scan';
import { weightSizes } from '../models/sizes';
import { expandHome } from '../supervisor/args';
import { removeProfile } from './profiles';

export interface ModelRouteDeps {
  db: Database;
  settings: SettingsRepo;
  profiles: ProfilesRepo;
  activeProfileId: () => number | null;
  benchRunner: Pick<BenchRunner, 'live'>;
  benchRuns: Pick<BenchRunsRepo, 'get'>;
  sweeps: Pick<SweepsRepo, 'running'>;
  downloadsRepo: Pick<DownloadsRepo, 'active'>;
}

export function modelRoutes(deps: ModelRouteDeps) {
  const { db, settings } = deps;
  const cache = new ModelCacheRepo(db);
  const modelsDir = () => {
    const setting = settings.get().modelsDir;
    return { setting, dir: expandHome(setting) };
  };
  const users: ModelUsers = {
    profiles: deps.profiles,
    activeProfileId: deps.activeProfileId,
    benchFiles: () => {
      const live = deps.benchRunner.live;
      const run = live ? deps.benchRuns.get(live.runId) : null;
      const sweep = deps.sweeps.running();
      return [run?.spec.modelPath, run?.spec.mmprojPath, sweep?.spec.modelPath, sweep?.spec.mmprojPath].map(
        (p) => p ?? null,
      );
    },
    downloads: () => deps.downloadsRepo.active(),
  };
  /** The model at `path`, from a fresh scan of the models folder (never a path taken as is from the client). */
  const entryOf = async (path: string) => {
    const { dir } = modelsDir();
    return { dir, entry: findEntry(await scanModels(dir, { cache }), dir, path) };
  };

  return {
    '/api/models': {
      GET: guarded(async () => {
        const { setting, dir } = modelsDir();
        const list: ModelList = {
          dir,
          setting,
          home: homedir(),
          scannedAt: Date.now(),
          models: await scanModels(dir, { cache }),
        };
        return Response.json(list);
      }),
      DELETE: guarded(async (req) => {
        const body = ModelDeleteSchema.parse(await jsonObject(req));
        const { dir, entry } = await entryOf(body.path);
        const usage = await modelUsage(entry, users);
        if (usage.blocked) throw new HttpError(409, usage.blocked, 'model-in-use');
        await deleteModelFiles(entry, dir);
        const deletedProfiles = body.deleteProfiles ? usage.profiles.map((p) => p.id) : [];
        for (const id of deletedProfiles) removeProfile(deps, id);
        const result: ModelDeleted = { deletedFiles: entry.files, deletedProfiles };
        return Response.json(result);
      }),
    },
    '/api/models/usage': {
      GET: guarded(async (req) => {
        const path = new URL(req.url).searchParams.get('path');
        if (!path) throw new HttpError(400, 'path required');
        return Response.json(await modelUsage((await entryOf(path)).entry, users));
      }),
    },
    '/api/models/info': {
      GET: guarded(async (req) => {
        const path = new URL(req.url).searchParams.get('path') ?? '';
        if (!path.startsWith('/') || !path.endsWith('.gguf'))
          throw new HttpError(400, 'Absolute path to a .gguf file expected');
        if (
          !(await stat(path).then(
            (s) => s.isFile(),
            () => false,
          ))
        )
          throw notFound('File');
        let info: Awaited<ReturnType<typeof readModel>>;
        try {
          info = await readModel(path);
        } catch (e) {
          throw new HttpError(422, (e as Error).message);
        }
        const { dir } = modelsDir();
        const relPath = path.startsWith(`${dir.replace(/\/+$/, '')}/`)
          ? path.slice(dir.replace(/\/+$/, '').length + 1)
          : path;
        const w = weightSizes(info.tensors);
        const detail: ModelDetail = {
          ...toSummary(info, relPath),
          tensorCount: info.tensors.length,
          weights: {
            embedBytes: w.embedBytes,
            outputBytes: w.outputBytes,
            layersBytes: w.layers.reduce((a, l) => a + l.otherBytes, 0),
            expertsBytes: w.layers.reduce((a, l) => a + l.expertsBytes, 0),
            otherBytes: w.otherBytes,
            totalBytes: w.totalBytes,
          },
        };
        return Response.json(detail);
      }),
    },
  };
}
