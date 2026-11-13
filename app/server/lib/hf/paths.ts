import { stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { HF_REPO_RE } from '@llama-webui/shared';
import { HttpError } from '../http';

/** Local folder of a repository's downloads: `<modelsDir>/<org>/<name>`. */
export function repoDir(modelsDir: string, repo: string): string {
  if (!HF_REPO_RE.test(repo)) throw new HttpError(400, `Invalid repository id: ${repo}`);
  const [org, name] = repo.split('/') as [string, string];
  return join(resolve(modelsDir), org, name);
}

/** Destination of a file of the repo, which must stay inside the repo's folder (no `..`, no absolute path). */
export function fileDest(dir: string, path: string): string {
  const root = resolve(dir);
  const dest = resolve(root, path);
  if (path.startsWith('/') || !dest.startsWith(`${root}${sep}`))
    throw new HttpError(400, `Invalid file path in the repository: ${path}`);
  return dest;
}

/** Temporary file of a download in progress (ignored by the models scan, which only keeps `*.gguf`). */
export const partPath = (dest: string) => `${dest}.part`;

/** Size of a file, null if it does not exist. */
export const sizeOf = (p: string): Promise<number | null> =>
  stat(p).then(
    (s) => s.size,
    () => null,
  );
