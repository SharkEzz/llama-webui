import type { DownloadItem, HfPresence, HfRepo, HfVariant } from '@llama-webui/shared';
import type { DownloadInput } from '../db/downloads';
import { HttpError } from '../http';
import type { HfClient } from './client';
import { fileDest, partPath, repoDir, sizeOf } from './paths';
import { groupRepoFiles, type RepoVariant } from './variants';

async function presence(dir: string, v: RepoVariant): Promise<HfPresence> {
  let complete = 0;
  let some = false;
  for (const f of v.files) {
    const dest = fileDest(dir, f.path);
    const size = await sizeOf(dest);
    if (size === f.size) complete++;
    else if (size !== null || (await sizeOf(partPath(dest))) !== null) some = true;
  }
  return complete === v.files.length ? 'complete' : complete > 0 || some ? 'partial' : 'none';
}

/** A repository as the download sheet shows it: its GGUF variants, what is already on disk or in the queue. */
export async function describeRepo(
  hf: Pick<HfClient, 'repoFiles' | 'endpoint'>,
  id: string,
  o: { modelsDir: string; active: DownloadItem[]; revision?: string },
): Promise<HfRepo> {
  const info = await hf.repoFiles(id, o.revision);
  const dir = repoDir(o.modelsDir, info.id);
  const { variants, projectors } = groupRepoFiles(info.files);
  const withState = (vs: RepoVariant[]): Promise<HfVariant[]> =>
    Promise.all(
      vs.map(async (v) => ({
        ...v,
        present: await presence(dir, v),
        queued: o.active.some((a) => a.repo === info.id && a.key === v.key),
      })),
    );
  return {
    id: info.id,
    sha: info.sha,
    gated: info.gated,
    url: `${hf.endpoint}/${info.id}`,
    dir,
    variants: await withState(variants),
    projectors: await withState(projectors),
  };
}

/** The download inputs for `keys`, read again from the repo at the pinned revision (sizes and sha256 from the Hub). */
export async function downloadInputs(
  hf: Pick<HfClient, 'repoFiles'>,
  req: { repo: string; revision: string; keys: string[] },
  modelsDir: string,
): Promise<DownloadInput[]> {
  const info = await hf.repoFiles(req.repo, req.revision);
  const dir = repoDir(modelsDir, info.id);
  const { variants, projectors } = groupRepoFiles(info.files);
  const all = [...variants, ...projectors];
  return req.keys.map((key) => {
    const v = all.find((x) => x.key === key);
    if (!v) throw new HttpError(404, `No GGUF “${key}” in ${req.repo}`, 'hf-not-found');
    for (const f of v.files) fileDest(dir, f.path);
    return {
      repo: info.id,
      revision: info.sha,
      key: v.key,
      name: v.name,
      quant: v.quant,
      kind: v.kind,
      dir,
      files: v.files,
    };
  });
}
