import { realpath, rm, rmdir } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { ModelEntry, ModelProfileUse, ModelUsage, Profile } from '@llama-webui/shared';
import { fileDest } from '../hf/paths';
import { notFound } from '../http';
import { profilePaths } from '../supervisor/args';

/** What uses model files right now: deleting them is refused while one of these opens them. */
export interface ModelUsers {
  profiles: { list(): Profile[]; get(id: number): Profile | null };
  activeProfileId: () => number | null;
  /** Model and projector of the benchmark or sweep in progress. */
  benchFiles: () => (string | null)[];
  /** Destination folders and files of the queued or running downloads. */
  downloads: () => { dir: string; files: { path: string }[] }[];
}

const real = (p: string) => realpath(p).catch(() => p);

/**
 * Whether a path another part of the app opens is one of `files`: as written, or once resolved (a profile that goes
 * through a symlinked folder). Not the other way: deleting a symlink leaves its target, and what uses the target.
 */
async function matcher(files: string[]): Promise<(p: string | null) => Promise<boolean>> {
  const set = new Set(files);
  return async (p) => p !== null && (set.has(resolve(p)) || set.has(await real(p)));
}

/** The scanned entry for `path`: deletion only ever touches files the scan found under the models folder. */
export function findEntry(models: ModelEntry[], root: string, path: string): ModelEntry {
  const entry = models.find((m) => m.path === path);
  const base = resolve(root);
  if (!entry) throw notFound('Model');
  if (!entry.files.every((f) => resolve(f).startsWith(base + sep))) throw notFound('Model');
  return entry;
}

export async function modelUsage(entry: ModelEntry, users: ModelUsers): Promise<ModelUsage> {
  const uses = await matcher(entry.files);
  const profiles: ModelProfileUse[] = [];
  for (const p of users.profiles.list()) {
    const paths = profilePaths(p);
    if (await uses(paths.model)) profiles.push({ id: p.id, name: p.name, role: 'model' });
    else if (await uses(paths.mmproj)) profiles.push({ id: p.id, name: p.name, role: 'mmproj' });
  }
  return {
    path: entry.path,
    files: entry.files,
    fileBytes: entry.fileBytes,
    profiles,
    blocked: await blockedBy(uses, users),
  };
}

async function blockedBy(uses: (p: string | null) => Promise<boolean>, users: ModelUsers): Promise<string | null> {
  const activeId = users.activeProfileId();
  const active = activeId === null ? null : users.profiles.get(activeId);
  if (active) {
    const { model, mmproj } = profilePaths(active);
    if ((await uses(model)) || (await uses(mmproj)))
      return `The running server uses it (profile “${active.name}”): stop it first`;
  }
  for (const f of users.benchFiles()) if (await uses(f)) return 'A benchmark in progress uses it';
  for (const d of users.downloads())
    for (const f of d.files) if (await uses(fileDest(d.dir, f.path))) return 'A download in progress writes it';
  return null;
}

/** Deletes the entry's files (a symlink: the link only), then the folders left empty up to the models folder. */
export async function deleteModelFiles(entry: ModelEntry, root: string): Promise<void> {
  for (const f of entry.files) await rm(f, { force: true });
  const base = resolve(root);
  const dirs = new Set<string>();
  for (const f of entry.files) for (let d = dirname(resolve(f)); d.startsWith(base + sep); d = dirname(d)) dirs.add(d);
  // Deepest first; rmdir fails on a folder that still holds something, which is kept.
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) await rmdir(d).catch(() => {});
}
