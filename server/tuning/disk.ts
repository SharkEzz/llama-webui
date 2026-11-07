import type { DiskSpeed } from '@llama-webui/shared';
import { HttpError } from '../http';

const GiB = 1024 ** 3;
const MIN_BYTES = 64 * 1024 ** 2;

/**
 * Sequential-read bandwidth of the model's disk: reads `bytes` bytes from some point in the file (random by default, to
 * avoid the already-cached start) and times it. The OS page cache can inflate the measurement.
 */
export async function measureDiskSpeed(
  path: string,
  o: { bytes?: number; offsetFraction?: number; now?: () => number } = {},
): Promise<DiskSpeed> {
  const now = o.now ?? performance.now.bind(performance);
  const file = Bun.file(path);
  if (!(await file.exists())) throw new HttpError(404, `File not found: ${path}`);
  const size = file.size;
  // At most 1 GiB, at most the whole file; below 64 MiB the measurement is meaningless.
  const bytes = Math.min(o.bytes ?? GiB, size);
  if (bytes < MIN_BYTES) throw new HttpError(400, `File too small to measure (${Math.round(size / 1024 ** 2)} MiB)`);
  const start = Math.floor((size - bytes) * (o.offsetFraction ?? Math.random()));
  const t0 = now();
  let read = 0;
  for await (const chunk of file.slice(start, start + bytes).stream()) read += chunk.byteLength;
  const seconds = Math.max(1e-6, (now() - t0) / 1000);
  return { bytesPerSec: read / seconds, sampledBytes: read, path, at: Date.now() };
}
