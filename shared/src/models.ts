export type ModelKind = 'model' | 'mmproj';

/** Résumé d'un GGUF (en-tête seulement), mis en cache en base. */
export interface ModelSummary {
  /** Chemin absolu du fichier (le premier shard d'un modèle découpé). */
  path: string;
  /** Chemin relatif au dossier des modèles. */
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
  /** Maximum sur les couches. */
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
  /** Dossier des modèles développé (absolu). */
  dir: string;
  /** Dossier des modèles tel que saisi dans les réglages (`~` compris). */
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

/** `abs` relatif à `dir` s'il est dedans, sinon null. */
function relativeTo(abs: string, dir: string): string | null {
  const d = trimSlash(dir);
  return abs.startsWith(`${d}/`) ? abs.slice(d.length + 1) : null;
}

/**
 * Chemin de modèle à écrire dans un profil : sans dossier de travail, celui des modèles est pris (tel que saisi) et le
 * chemin lui est relatif ; sous le dossier de travail, relatif ; ailleurs, absolu.
 */
export function profileModelPath(
  abs: string,
  o: { cwd?: string; modelsDir: string; home: string },
): { cwd?: string; model: string } {
  const cwd = o.cwd?.trim() ? o.cwd.trim() : o.modelsDir;
  const rel = relativeTo(abs, expand(cwd, o.home));
  return { cwd, model: rel ?? abs };
}
