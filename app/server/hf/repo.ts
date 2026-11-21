import {
  type DownloadRequest,
  type HfFile,
  type HfInvalidPath,
  HfNotFound,
  type HfPresence,
  type HfRepo,
  type HfVariant,
  ListedTwice,
  type ModelKind,
} from '@llama-webui/shared';
import { Array as Arr, Effect, type FileSystem, Option, type Path } from 'effect';
import { modelsRoot } from '../models/access.ts';
import type { SettingsRepo } from '../settings/SettingsRepo.ts';
import { HfClient, type HubError } from './HfClient.ts';
import { fileDest, partPath, repoDir, sizeOf } from './paths.ts';
import { hfEndpoint } from './token.ts';
import { groupRepoFiles, type RepoVariant } from './variants.ts';

/** A variant to download as the queue takes it: the repository's canonical id, the commit, the files left to write. */
export interface NewDownload {
  readonly repo: string;
  readonly revision: string;
  readonly key: string;
  readonly name: string;
  readonly quant: string | null;
  readonly kind: ModelKind;
  /** The repository's folder under the models folder. */
  readonly dir: string;
  readonly files: ReadonlyArray<HfFile>;
}

/** Where a file stands on disk: in place at its size, begun (at another size, or a `.part`), or absent. */
const fileState = Effect.fn('repo.fileState')(function* (dir: string, file: HfFile) {
  const dest = yield* fileDest(dir, file.path);
  const size = yield* sizeOf(dest);
  if (Option.contains(size, file.size)) return 'complete' as const;
  if (Option.isSome(size)) return 'begun' as const;
  const part = yield* sizeOf(partPath(dest));
  return Option.isSome(part) ? ('begun' as const) : ('absent' as const);
});

/** A variant's state on disk: all its files in place, some of them (or a begun one), or none. */
const presence = Effect.fn('repo.presence')(function* (dir: string, variant: RepoVariant) {
  const states = yield* Effect.forEach(variant.files, (file) => fileState(dir, file));
  const present: HfPresence = Arr.every(states, (state) => state === 'complete')
    ? 'complete'
    : Arr.some(states, (state) => state !== 'absent')
      ? 'partial'
      : 'none';
  return present;
});

const withPresence = (dir: string, variants: ReadonlyArray<RepoVariant>) =>
  Effect.forEach(variants, (variant) =>
    Effect.map(presence(dir, variant), (present): HfVariant => ({ ...variant, present })),
  );

/**
 * A repository as the download sheet shows it, at `revision` (a branch, a tag or a commit): its GGUF variants and
 * projectors, what of each is on disk, its page, its folder, and the commit its downloads are pinned to. Whether a
 * variant is queued is the queue's to tell (the web reads it from the queue it shows).
 */
export const describeRepo = Effect.fn('repo.describeRepo')(function* (
  id: string,
  revision: string,
): Effect.fn.Return<HfRepo, HubError | HfInvalidPath, HfClient | FileSystem.FileSystem | Path.Path | SettingsRepo> {
  const client = yield* HfClient;
  const info = yield* client.repoFiles(id, revision);
  const { dir: modelsDir } = yield* modelsRoot;
  const dir = yield* repoDir(modelsDir, info.id);
  const { variants, projectors } = groupRepoFiles(info.files);
  const endpoint = yield* hfEndpoint;
  return {
    id: info.id,
    sha: info.sha,
    gated: info.gated,
    url: `${endpoint}/${info.id}`,
    dir,
    variants: yield* withPresence(dir, variants),
    projectors: yield* withPresence(dir, projectors),
  };
});

/**
 * What to queue for `request`: the repository read again at the pinned commit (sizes and sha256 from the Hub), each key
 * found among its variants and projectors (`No GGUF “<key>” in <repo>`), a key given twice refused, every path checked
 * to stay in the repository's folder. The files already on disk at their size are left out, and a variant with nothing
 * left to write is skipped.
 */
export const downloadInputs = Effect.fn('repo.downloadInputs')(function* (
  request: DownloadRequest,
): Effect.fn.Return<
  ReadonlyArray<NewDownload>,
  HubError | HfInvalidPath | ListedTwice,
  HfClient | FileSystem.FileSystem | Path.Path | SettingsRepo
> {
  const client = yield* HfClient;
  const info = yield* client.repoFiles(request.repo, request.revision);
  const { dir: modelsDir } = yield* modelsRoot;
  const dir = yield* repoDir(modelsDir, info.id);
  const { variants, projectors } = groupRepoFiles(info.files);
  const all = Arr.appendAll(variants, projectors);
  const chosen = yield* Effect.forEach(request.keys, (key) =>
    Effect.gen(function* () {
      const variant = Arr.findFirst(all, (v) => v.key === key);
      if (Option.isNone(variant)) {
        return yield* HfNotFound.make({ message: `No GGUF “${key}” in ${request.repo}` });
      }
      yield* Effect.forEach(variant.value.files, (file) => fileDest(dir, file.path), { discard: true });
      return variant.value;
    }),
  );
  const twice = Arr.findFirst(chosen, (variant, i) => Arr.some(Arr.take(chosen, i), (v) => v.key === variant.key));
  if (Option.isSome(twice)) return yield* ListedTwice.make({ message: `${twice.value.name} is listed twice` });
  const inputs = yield* Effect.forEach(chosen, (variant) =>
    Effect.map(
      Effect.filter(variant.files, (file) => Effect.map(fileState(dir, file), (state) => state !== 'complete')),
      (files): NewDownload => ({
        repo: info.id,
        revision: info.sha,
        key: variant.key,
        name: variant.name,
        quant: variant.quant,
        kind: variant.kind,
        dir,
        files,
      }),
    ),
  );
  return Arr.filter(inputs, (input) => Arr.isReadonlyArrayNonEmpty(input.files));
});
