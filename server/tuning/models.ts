import { stat } from 'node:fs/promises';
import { HttpError, notFound } from '../http';
import { type ModelInfo, readModel } from '../models/gguf';

const cache = new Map<string, { stamp: string; info: ModelInfo }>();

/** Parsed GGUF (cached while size and mtime are unchanged); 400 invalid path, 404 missing, 422 unreadable. */
export async function loadModel(path: string): Promise<ModelInfo> {
  if (!path.startsWith('/') || !path.endsWith('.gguf'))
    throw new HttpError(400, 'Expected an absolute path to a .gguf file');
  const st = await stat(path).catch(() => null);
  if (!st?.isFile()) throw notFound('Model');
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

/** Projector size (0 without a projector; 404 if missing). */
export async function mmprojBytes(path: string | null | undefined): Promise<number> {
  if (!path) return 0;
  const st = await stat(path).catch(() => null);
  if (!st?.isFile()) throw notFound('Projector');
  return st.size;
}
