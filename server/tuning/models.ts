import { stat } from 'node:fs/promises';
import { HttpError, notFound } from '../http';
import { type ModelInfo, readModel } from '../models/gguf';

const cache = new Map<string, { stamp: string; info: ModelInfo }>();

/** GGUF lu (en cache tant que taille et date ne changent pas) ; 400 chemin invalide, 404 absent, 422 illisible. */
export async function loadModel(path: string): Promise<ModelInfo> {
  if (!path.startsWith('/') || !path.endsWith('.gguf'))
    throw new HttpError(400, 'Chemin absolu de fichier .gguf attendu');
  const st = await stat(path).catch(() => null);
  if (!st?.isFile()) throw notFound('Modèle');
  const stamp = `${st.size}:${st.mtimeMs}`;
  const hit = cache.get(path);
  if (hit?.stamp === stamp) return hit.info;
  try {
    const info = await readModel(path);
    cache.set(path, { stamp, info });
    return info;
  } catch (e) {
    throw new HttpError(422, (e as Error).message);
  }
}

/** Taille du projecteur (0 sans projecteur ; 404 s'il manque). */
export async function mmprojBytes(path: string | null | undefined): Promise<number> {
  if (!path) return 0;
  const st = await stat(path).catch(() => null);
  if (!st?.isFile()) throw notFound('Projecteur');
  return st.size;
}
