import type { ModelEntry, ModelSummary } from '@llama-webui/shared';
import { Array as Arr, Effect, FileSystem, Number as Num, Option, Order, Path, String as Str } from 'effect';
import { dual } from 'effect/Function';
import { GgufReader, stampOf } from './GgufReader.ts';
import type { ModelInfo } from './gguf.ts';
import { ModelCacheRepo } from './ModelCacheRepo.ts';

const SHARD = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/;

/** One model of the folder: its first file, the parts found, the parts missing (relative paths). */
export interface GgufGroup {
  readonly main: string;
  readonly files: ReadonlyArray<string>;
  readonly missing: ReadonlyArray<string>;
}

const byMain = Order.mapInput(Order.String, (g: GgufGroup) => g.main);

/** Groups the `-0000k-of-0000N.gguf` parts under the first one; reports missing parts. Sorted by main file. */
export const groupGgufFiles = (relPaths: ReadonlyArray<string>): Array<GgufGroup> => {
  const shards = new Map<string, { prefix: string; total: string; parts: Set<number> }>();
  const out: Array<GgufGroup> = [];
  for (const p of relPaths) {
    const m = Option.fromNullishOr(SHARD.exec(p));
    if (Option.isNone(m)) {
      out.push({ main: p, files: [p], missing: [] });
      continue;
    }
    const [, prefix = '', part = '', total = ''] = m.value;
    const key = `${prefix}|${total}`;
    const group = shards.get(key) ?? { prefix, total, parts: new Set<number>() };
    shards.set(key, group);
    group.parts.add(Number(part));
  }
  for (const { prefix, total, parts } of shards.values()) {
    const name = (i: number) => `${prefix}-${Str.padStart(5, '0')(String(i))}-of-${total}.gguf`;
    // `Arr.range` is never empty: a `-of-00000` name has no part, as in the Nitro server.
    const all = Number(total) >= 1 ? Arr.range(1, Number(total)) : [];
    out.push({
      main: name(1),
      files: Arr.map(
        Arr.filter(all, (i) => parts.has(i)),
        name,
      ),
      missing: Arr.map(
        Arr.filter(all, (i) => !parts.has(i)),
        name,
      ),
    });
  }
  return Arr.sort(out, byMain);
};

/** The summary of a model read whole, under its path relative to the models folder. */
export const toSummary: {
  (relPath: string): (info: ModelInfo) => ModelSummary;
  (info: ModelInfo, relPath: string): ModelSummary;
} = dual(
  2,
  (info: ModelInfo, relPath: string): ModelSummary => ({
    path: info.path,
    relPath,
    files: info.files,
    fileBytes: info.fileBytes,
    kind: info.kind,
    arch: info.arch,
    name: info.name,
    quant: info.quant,
    params: info.params,
    blockCount: info.blockCount,
    contextLength: info.contextLength,
    embeddingLength: info.embeddingLength,
    headCount: info.headCount,
    headCountKv: Arr.reduce(info.headCountKv, 0, (a, b) => Math.max(a, b)),
    expertCount: info.expertCount,
    expertUsedCount: info.expertUsedCount,
    nextnLayers: info.nextnLayers,
    recurrent: info.recurrent,
    slidingWindow: info.slidingWindow,
    hasChatTemplate: info.hasChatTemplate,
  }),
);

/**
 * The `*.gguf` files under `root` (relative paths, `/`-separated): names starting with “.” are skipped, directory
 * links are not followed, a `.gguf` link is kept when it leads to a regular file, a folder that cannot be read is
 * skipped.
 */
const ggufFiles = Effect.fnUntraced(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const walk = (rel: string): Effect.Effect<ReadonlyArray<string>> =>
    Effect.gen(function* () {
      const entries = yield* fs
        .readDirectoryEntries(Str.isEmpty(rel) ? root : path.join(root, rel))
        .pipe(Effect.orElseSucceed((): ReadonlyArray<FileSystem.DirectoryEntry> => []));
      const found = yield* Effect.forEach(entries, (entry): Effect.Effect<ReadonlyArray<string>> => {
        if (Str.startsWith('.')(entry.name)) return Effect.succeed([]);
        const at = Str.isEmpty(rel) ? entry.name : `${rel}/${entry.name}`;
        if (entry.type === 'Directory') return walk(at);
        if (!Str.endsWith('.gguf')(entry.name)) return Effect.succeed([]);
        if (entry.type === 'File') return Effect.succeed([at]);
        if (entry.type !== 'SymbolicLink') return Effect.succeed([]);
        return fs.stat(path.join(root, at)).pipe(
          Effect.map((info) => (info.type === 'File' ? [at] : [])),
          Effect.orElseSucceed(() => []),
        );
      });
      return Arr.flatten(found);
    });

  return yield* walk('');
});

/**
 * The GGUFs under `root`, one entry per model (shards grouped), sorted by relative path. A summary of `model_cache` is
 * used while the stamp of its parts is unchanged; a model read again is written there; one that cannot be read is an
 * `ok: false` entry, never cached, and the scan goes on. The rows of the files no longer there are pruned. A missing
 * or unreadable `root` has no model.
 */
export const scanModels = Effect.fn('scanModels')(function* (
  root: string,
): Effect.fn.Return<ReadonlyArray<ModelEntry>, never, FileSystem.FileSystem | Path.Path | GgufReader | ModelCacheRepo> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const reader = yield* GgufReader;
  const cache = yield* ModelCacheRepo;

  const entryOf = Effect.fnUntraced(function* (group: GgufGroup) {
    const main = path.join(root, group.main);
    const files = Arr.map(group.files, (file) => path.join(root, file));
    const stats = yield* Effect.forEach(files, (file) => Effect.option(fs.stat(file)));
    const fileBytes = Num.sumAll(Arr.map(Arr.getSomes(stats), (info) => Number(info.size)));
    const fail = (error: string): ModelEntry => ({
      ok: false,
      path: main,
      relPath: group.main,
      files,
      fileBytes,
      error,
    });
    if (Arr.isReadonlyArrayNonEmpty(group.missing)) {
      return fail(
        `missing shard: ${Arr.join(
          Arr.map(group.missing, (m) => path.basename(m)),
          ', ',
        )}`,
      );
    }
    // A part that cannot be stat'ed has no stamp: the read tells why.
    const stamp = Arr.every(stats, Option.isSome) ? Option.some(stampOf(Arr.getSomes(stats))) : Option.none();
    if (Option.isSome(stamp)) {
      const hit = yield* cache.get(main);
      if (Option.isSome(hit) && hit.value.stamp === stamp.value) {
        return { ok: true, ...hit.value.summary, relPath: group.main } satisfies ModelEntry;
      }
    }
    return yield* reader.read(main).pipe(
      Effect.matchEffect({
        onFailure: (error) => Effect.succeed(fail(error.message)),
        onSuccess: (info) => {
          const summary = toSummary(info, group.main);
          const entry: ModelEntry = { ok: true, ...summary };
          return Option.match(stamp, {
            onNone: () => Effect.succeed(entry),
            onSome: (at) => cache.put(main, at, summary).pipe(Effect.as(entry)),
          });
        },
      }),
    );
  });

  const found = yield* ggufFiles(root);
  const groups = groupGgufFiles(found);
  const entries = yield* Effect.forEach(groups, entryOf, { concurrency: 'unbounded' });
  yield* cache.prune(Arr.map(groups, (group) => path.join(root, group.main)));
  return entries;
});
