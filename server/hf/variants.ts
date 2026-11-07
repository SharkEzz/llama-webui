import { parseGGUFQuantLabel, parseGgufShardFilename } from '@huggingface/gguf';
import type { HfFile, HfVariant } from '@llama-webui/shared';

export type RepoVariant = Omit<HfVariant, 'present' | 'queued'>;

const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const stem = (p: string) => basename(p).replace(/(-\d{5}-of-\d{5})?\.gguf$/i, '');

/**
 * The repo's GGUF files grouped into downloadable variants: one per file, or one per shard set
 * (`…-00001-of-00003.gguf`, possibly in a subfolder). Projectors (`mmproj` in the name) are kept apart;
 * other files (README, safetensors, imatrix…) are ignored. Smallest first.
 */
export function groupRepoFiles(files: HfFile[]): { variants: RepoVariant[]; projectors: RepoVariant[] } {
  const groups = new Map<string, HfFile[]>();
  for (const f of files) {
    if (!/\.gguf$/i.test(f.path)) continue;
    const shard = parseGgufShardFilename(f.path);
    const id = shard ? `${shard.prefix}\0${shard.total}` : f.path;
    const g = groups.get(id);
    if (g) g.push(f);
    else groups.set(id, [f]);
  }
  const variants: RepoVariant[] = [];
  const projectors: RepoVariant[] = [];
  for (const group of groups.values()) {
    const sorted = group.toSorted((a, b) => a.path.localeCompare(b.path));
    const first = sorted[0]!;
    const kind = /mmproj/i.test(basename(first.path)) ? 'mmproj' : 'model';
    const v: RepoVariant = {
      key: first.path,
      name: stem(first.path),
      quant: parseGGUFQuantLabel(basename(first.path)) ?? null,
      kind,
      files: sorted,
      totalBytes: sorted.reduce((a, f) => a + f.size, 0),
    };
    (kind === 'mmproj' ? projectors : variants).push(v);
  }
  const bySize = (a: RepoVariant, b: RepoVariant) => a.totalBytes - b.totalBytes || a.key.localeCompare(b.key);
  return { variants: variants.sort(bySize), projectors: projectors.sort(bySize) };
}
