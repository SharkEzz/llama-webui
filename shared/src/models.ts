export type ModelKind = 'model' | 'mmproj';

/** Summary of a GGUF (header only), cached in the database. */
export interface ModelSummary {
  /** Absolute path of the file (the first shard of a split model). */
  path: string;
  /** Path relative to the models directory. */
  relPath: string;
  files: string[];
  fileBytes: number;
  kind: ModelKind;
  arch: string;
  name: string;
  quant: string;
  params: number;
  blockCount: number;
  contextLength: number;
  embeddingLength: number;
  headCount: number;
  /** Maximum across layers. */
  headCountKv: number;
  expertCount: number;
  expertUsedCount: number;
  nextnLayers: number;
  recurrent: boolean;
  slidingWindow: number | null;
  hasChatTemplate: boolean;
}

export type ModelEntry =
  | ({ ok: true } & ModelSummary)
  | { ok: false; path: string; relPath: string; files: string[]; fileBytes: number; error: string };

export interface ModelList {
  /** Models directory, expanded (absolute). */
  dir: string;
  /** Models directory as entered in the settings (`~` included). */
  setting: string;
  home: string;
  scannedAt: number;
  models: ModelEntry[];
}

export interface ModelDetail extends ModelSummary {
  tensorCount: number;
  weights: {
    embedBytes: number;
    outputBytes: number;
    layersBytes: number;
    expertsBytes: number;
    otherBytes: number;
    totalBytes: number;
  };
}

const expand = (p: string, home: string) => (p === '~' ? home : p.startsWith('~/') ? `${home}/${p.slice(2)}` : p);
const trimSlash = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);

/** `abs` relative to `dir` if inside it, otherwise null. */
function relativeTo(abs: string, dir: string): string | null {
  const d = trimSlash(dir);
  return abs.startsWith(`${d}/`) ? abs.slice(d.length + 1) : null;
}

/**
 * Model path to write into a profile: without a working directory, the models directory is used (as entered) and the
 * path is relative to it; under the working directory, relative; elsewhere, absolute.
 */
export function profileModelPath(
  abs: string,
  o: { cwd?: string; modelsDir: string; home: string },
): { cwd?: string; model: string } {
  const cwd = o.cwd?.trim() ? o.cwd.trim() : o.modelsDir;
  const rel = relativeTo(abs, expand(cwd, o.home));
  return { cwd, model: rel ?? abs };
}
