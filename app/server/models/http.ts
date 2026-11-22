import { Api, type ModelDetail, ModelFileNotFound, type ModelList, ModelUnreadable } from '@llama-webui/shared';
import { Array as Arr, Clock, Effect, FileSystem, Number as Num, Option, type Path, String as Str } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import { homeDir } from '../config/Home.ts';
import { withoutTrailingSlash } from '../config/paths.ts';
import type { ProfilesRepo } from '../profiles/ProfilesRepo.ts';
import type { SettingsRepo } from '../settings/SettingsRepo.ts';
import type { Supervisor } from '../supervisor/Supervisor.ts';
import { findEntry, modelsRoot } from './access.ts';
import type { ActiveWrites } from './ActiveWrites.ts';
import { checkModelPath } from './allowedPath.ts';
import { GgufReader } from './GgufReader.ts';
import type { ModelCacheRepo } from './ModelCacheRepo.ts';
import { scanModels, toSummary } from './scan.ts';
import { weightSizes } from './sizes.ts';
import { deleteModel, modelUsage } from './usage.ts';

/** `path` relative to `dir` when it is inside it, else as it is (absolute). */
const relativeTo = (path: string, dir: string): string => {
  const base = withoutTrailingSlash(dir);
  return Str.startsWith(`${base}/`)(path) ? Str.slice(base.length + 1)(path) : path;
};

/** The endpoints of `/api/models`: the models folder scanned on each call, a GGUF's detail, a model's usage and deletion. */
export const ModelsHandlers = HttpApiBuilder.group(
  Api,
  'models',
  Effect.fn(function* (handlers) {
    const fs = yield* FileSystem.FileSystem;
    const reader = yield* GgufReader;
    // Taken when the routes are built: a handler then needs nothing from the request.
    const services = yield* Effect.context<
      | SettingsRepo
      | ProfilesRepo
      | Supervisor
      | ActiveWrites
      | GgufReader
      | ModelCacheRepo
      | FileSystem.FileSystem
      | Path.Path
    >();

    const list = Effect.gen(function* () {
      const { dir, setting } = yield* modelsRoot;
      const home = yield* homeDir;
      const scannedAt = yield* Clock.currentTimeMillis;
      const models = yield* scanModels(dir);
      const reply: ModelList = { dir, setting, home, scannedAt, models };
      return reply;
    }).pipe(Effect.withSpan('ModelsHandlers.list'));

    /** The model of the models folder at `path`, from a scan made now; and the folder. */
    const entryAt = Effect.fn('ModelsHandlers.entryAt')(function* (path: string) {
      const { dir } = yield* modelsRoot;
      const models = yield* scanModels(dir);
      const entry = yield* findEntry({ models, root: dir, path });
      return { dir, entry };
    });

    const usage = Effect.fn('ModelsHandlers.usage')(function* (path: string) {
      const { entry } = yield* entryAt(path);
      return yield* modelUsage(entry);
    });

    const remove = Effect.fn('ModelsHandlers.remove')(function* (path: string, deleteProfiles: boolean) {
      const { dir, entry } = yield* entryAt(path);
      return yield* deleteModel({ entry, root: dir, deleteProfiles });
    });

    /**
     * The detail of the GGUF at `path`, under the models folder or a profile's (`checkModelPath`): `relPath` relative
     * to the models folder when inside it.
     */
    const info = Effect.fn('ModelsHandlers.info')(function* (path: string) {
      yield* checkModelPath(path);
      const stat = yield* Effect.option(fs.stat(path));
      if (Option.isNone(stat) || stat.value.type !== 'File') {
        return yield* ModelFileNotFound.make({ message: 'File not found' });
      }
      const model = yield* reader
        .read(path)
        .pipe(Effect.mapError((error) => ModelUnreadable.make({ message: error.message })));
      const { dir } = yield* modelsRoot;
      const sizes = weightSizes(model.tensors);
      const detail: ModelDetail = {
        ...toSummary(model, relativeTo(path, dir)),
        tensorCount: model.tensors.length,
        weights: {
          embedBytes: sizes.embedBytes,
          outputBytes: sizes.outputBytes,
          layersBytes: Num.sumAll(Arr.map(sizes.layers, (layer) => layer.otherBytes)),
          expertsBytes: Num.sumAll(Arr.map(sizes.layers, (layer) => layer.expertsBytes)),
          otherBytes: sizes.otherBytes,
          totalBytes: sizes.totalBytes,
        },
      };
      return detail;
    });

    return handlers
      .handle('list', () => Effect.provideContext(list, services))
      .handle('remove', ({ payload }) => Effect.provideContext(remove(payload.path, payload.deleteProfiles), services))
      .handle('info', ({ query }) => Effect.provideContext(info(query.path), services))
      .handle('usage', ({ query }) => Effect.provideContext(usage(query.path), services));
  }),
);
