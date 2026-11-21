import { parseGGUFQuantLabel, parseGgufShardFilename } from '@huggingface/gguf';
import type { HfFile, HfVariant } from '@llama-webui/shared';
import { Array as Arr, Number as Num, Option, Order, Record as Rec, String as Str } from 'effect';

/** A variant as the repository's files make it, before what is on disk is known. */
export type RepoVariant = Omit<HfVariant, 'present'>;

const basename = (path: string): string => Option.getOrElse(Arr.last(Str.split(path, '/')), () => path);
const stem = (path: string): string => Str.replace(/(-\d{5}-of-\d{5})?\.gguf$/i, '')(basename(path));

/** Paths in the order of the Nitro server: `localeCompare`. */
const byPath = Order.make<HfFile>((a, b) => Str.localeCompare(b.path)(a.path));
const bySize = Order.combine(
  Order.mapInput(Num.Order, (v: RepoVariant) => v.totalBytes),
  Order.make<RepoVariant>((a, b) => Str.localeCompare(b.key)(a.key)),
);

/** A GGUF that is a model or a projector: imatrix files can be GGUF too (calibration data, not a model; #31). */
const isOffered = (file: HfFile): boolean => /\.gguf$/i.test(file.path) && !/^imatrix/i.test(basename(file.path));

/** The group of a file: its shard set (prefix and count), else the file alone. */
const groupOf = (file: HfFile): string => {
  const shard = parseGgufShardFilename(file.path);
  return shard === null ? file.path : `${shard.prefix}\0${shard.total}`;
};

const variantOf = (files: Arr.NonEmptyReadonlyArray<HfFile>): RepoVariant => {
  const sorted = Arr.sort(files, byPath);
  const first = Arr.headNonEmpty(sorted);
  return {
    key: first.path,
    name: stem(first.path),
    quant: parseGGUFQuantLabel(basename(first.path)) ?? null,
    kind: /mmproj/i.test(basename(first.path)) ? 'mmproj' : 'model',
    files: sorted,
    totalBytes: Num.sumAll(Arr.map(sorted, (file) => file.size)),
  };
};

/**
 * The repository's GGUF files grouped into downloadable variants: one per file, or one per shard set
 * (`…-00001-of-00003.gguf`, possibly in a subfolder). Projectors (`mmproj` in the name) are kept apart; other files
 * (README, safetensors, imatrix…) are ignored. Smallest first.
 */
export const groupRepoFiles = (
  files: ReadonlyArray<HfFile>,
): { readonly variants: ReadonlyArray<RepoVariant>; readonly projectors: ReadonlyArray<RepoVariant> } => {
  const groups = Arr.map(Rec.values(Arr.groupBy(Arr.filter(files, isOffered), groupOf)), variantOf);
  return {
    variants: Arr.sort(
      Arr.filter(groups, (v) => v.kind === 'model'),
      bySize,
    ),
    projectors: Arr.sort(
      Arr.filter(groups, (v) => v.kind === 'mmproj'),
      bySize,
    ),
  };
};
