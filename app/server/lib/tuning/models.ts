import { stat } from 'node:fs/promises';
import { HttpError, notFound } from '../http';
import { type ModelInfo, readModel } from '../models/gguf';

/**
 * Parsed GGUF, from `readModel()`'s cache (8 models, while the size and mtime of every part are unchanged); 400 invalid
 * path, 404 missing, 422 unreadable.
 */
export async function loadModel(path: string): Promise<ModelInfo> {
  if (!path.startsWith('/') || !path.endsWith('.gguf'))
    throw new HttpError(400, 'Expected an absolute path to a .gguf file');
  const st = await stat(path).catch(() => null);
  if (!st?.isFile()) throw notFound('Model');
  try {
    return await readModel(path);
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
