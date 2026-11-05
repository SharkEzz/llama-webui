import type { DiskSpeed } from "@llama-webui/shared";
import { HttpError } from "../http";

const GiB = 1024 ** 3;

/**
 * Débit de lecture séquentielle du disque du modèle : lit `bytes` octets à partir d'un point du fichier (aléatoire par
 * défaut, pour éviter le début déjà en cache) et chronomètre. Le cache du système peut gonfler la mesure.
 */
export async function measureDiskSpeed(path: string, o: { bytes?: number; offsetFraction?: number; now?: () => number } = {}): Promise<DiskSpeed> {
  const now = o.now ?? performance.now.bind(performance);
  const file = Bun.file(path);
  if (!(await file.exists())) throw new HttpError(404, `Fichier introuvable : ${path}`);
  const size = file.size;
  const bytes = o.bytes ?? GiB;
  if (size < bytes) throw new HttpError(400, `Fichier trop petit pour mesurer (${Math.round(size / 1024 ** 2)} Mio < ${Math.round(bytes / 1024 ** 2)} Mio)`);
  const start = Math.floor((size - bytes) * (o.offsetFraction ?? Math.random()));
  const t0 = now();
  let read = 0;
  for await (const chunk of file.slice(start, start + bytes).stream()) read += chunk.byteLength;
  const seconds = Math.max(1e-6, (now() - t0) / 1000);
  return { bytesPerSec: read / seconds, sampledBytes: read, path, at: Date.now() };
}
