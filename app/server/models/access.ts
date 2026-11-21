import { type ModelEntry, ModelNotFound } from '@llama-webui/shared';
import { Array as Arr, Effect, Option, Path, String as Str } from 'effect';
import { expandHome } from '../config/Home.ts';
import { SettingsRepo } from '../settings/SettingsRepo.ts';

/** The models folder: the `modelsDir` setting as typed (`setting`) and with `~` expanded (`dir`). */
export const modelsRoot: Effect.Effect<
  { readonly dir: string; readonly setting: string },
  never,
  SettingsRepo | Path.Path
> = Effect.gen(function* () {
  const settings = yield* SettingsRepo;
  const { modelsDir } = yield* settings.get;
  const dir = yield* expandHome(modelsDir);
  return { dir, setting: modelsDir };
}).pipe(Effect.withSpan('models.modelsRoot'));

const notFound = () => ModelNotFound.make({ message: 'Model not found' });

/**
 * The scanned entry of `path`: what a usage or a deletion touches is a model the scan found under the models folder,
 * never a path taken as is from the client. A later shard is not an entry; an entry one of whose files resolves outside
 * `root` is not found either.
 */
export const findEntry = Effect.fn('models.findEntry')(function* (options: {
  readonly models: ReadonlyArray<ModelEntry>;
  readonly root: string;
  readonly path: string;
}): Effect.fn.Return<ModelEntry, ModelNotFound, Path.Path> {
  const paths = yield* Path.Path;
  const entry = Arr.findFirst(options.models, (model) => model.path === options.path);
  if (Option.isNone(entry)) return yield* notFound();
  const base = `${paths.resolve(options.root)}${paths.sep}`;
  const inside = Arr.every(entry.value.files, (file) => Str.startsWith(base)(paths.resolve(file)));
  return inside ? entry.value : yield* notFound();
});
