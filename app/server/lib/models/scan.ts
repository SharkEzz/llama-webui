import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { ModelEntry, ModelSummary } from '@llama-webui/shared';
import type { ModelCacheRepo } from '../db/modelCache';
import { type ModelInfo, readModel } from './gguf';

const SHARD = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/;

/** Groups the `-0000k-of-0000N.gguf` parts under the first one; reports missing parts. Sorted by main file. */
export function groupGgufFiles(relPaths: string[]): { main: string; files: string[]; missing: string[] }[] {
  const shards = new Map<string, { total: number; parts: Set<number> }>();
  const out: { main: string; files: string[]; missing: string[] }[] = [];
  for (const p of relPaths) {
    const m = SHARD.exec(p);
    if (!m) {
      out.push({ main: p, files: [p], missing: [] });
      continue;
    }
    const key = `${m[1]}|${m[3]}`;
    let g = shards.get(key);
    if (!g) {
      g = { total: Number(m[3]), parts: new Set() };
      shards.set(key, g);
    }
    g.parts.add(Number(m[2]));
  }
  for (const [key, g] of shards) {
    const [prefix, total] = key.split('|') as [string, string];
    const name = (i: number) => `${prefix}-${String(i).padStart(5, '0')}-of-${total}.gguf`;
    const files: string[] = [];
    const missing: string[] = [];
    for (let i = 1; i <= g.total; i++) (g.parts.has(i) ? files : missing).push(name(i));
    out.push({ main: name(1), files, missing });
  }
  return out.sort((a, b) => (a.main < b.main ? -1 : a.main > b.main ? 1 : 0));
}

/** The `*.gguf` files under `dir` (relative paths); names starting with “.” are ignored, directory links not followed. */
async function walk(dir: string, rel = ''): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(join(dir, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walk(dir, r)));
    else if (e.name.endsWith('.gguf')) {
      if (e.isFile()) out.push(r);
      else if (
        e.isSymbolicLink() &&
        (await stat(join(dir, r)).then(
          (s) => s.isFile(),
          () => false,
        ))
      )
        out.push(r);
    }
  }
  return out;
}

export function toSummary(info: ModelInfo, relPath: string): ModelSummary {
  return {
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
    headCountKv: info.headCountKv.reduce((a, b) => Math.max(a, b), 0),
    expertCount: info.expertCount,
    expertUsedCount: info.expertUsedCount,
    nextnLayers: info.nextnLayers,
    recurrent: info.recurrent,
    slidingWindow: info.slidingWindow,
    hasChatTemplate: info.hasChatTemplate,
  };
}

/**
 * The GGUFs in `dir`, one per model (shards grouped). A cached summary is used as long as the mtime and size of every
 * part are unchanged; an unreadable file becomes an `ok: false` entry (never cached) and the scan goes on.
 */
export async function scanModels(
  dir: string,
  o: { cache: ModelCacheRepo; read?: (path: string) => Promise<ModelInfo> },
): Promise<ModelEntry[]> {
  const read = o.read ?? readModel;
  const groups = groupGgufFiles(await walk(dir));
  const seen = new Set<string>();
  const entries = await Promise.all(
    groups.map(async (g): Promise<ModelEntry> => {
      const path = join(dir, g.main);
      seen.add(path);
      const stats = await Promise.all(g.files.map((f) => stat(join(dir, f)).catch(() => null)));
      const fileBytes = stats.reduce((a, s) => a + (s?.size ?? 0), 0);
      const files = g.files.map((f) => join(dir, f));
      const fail = (error: string): ModelEntry => ({ ok: false, path, relPath: g.main, files, fileBytes, error });
      if (g.missing.length > 0) return fail(`missing shard: ${g.missing.map((m) => basename(m)).join(', ')}`);
      const stamp = stats.map((s) => (s ? `${s.mtimeMs}:${s.size}` : '?')).join('|');
      const hit = o.cache.get(path);
      if (hit && hit.stamp === stamp) return { ok: true, ...hit.summary, relPath: g.main };
      try {
        const summary = toSummary(await read(path), g.main);
        o.cache.put(path, stamp, summary);
        return { ok: true, ...summary };
      } catch (e) {
        return fail((e as Error).message);
      }
    }),
  );
  o.cache.prune(seen);
  return entries;
}
