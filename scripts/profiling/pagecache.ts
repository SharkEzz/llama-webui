// The page cache around a profile's start: a model file read in a previous pass loads from memory in seconds, from the
// disk in tens of seconds. `launch` evicts the profile's GGUF files first (posix_fadvise DONTNEED through `dd`, no root
// needed for clean pages) and records what stayed cached, so that two runs compare like with like.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { arr, isRecord, str } from './json.ts';

const home = (p: string): string => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

/** The GGUF files a profile opens: its model, its projector and every `.gguf` of its arguments, with their shards. */
export function profileFiles(profile: unknown, serverCwd: string): string[] {
  if (!isRecord(profile)) return [];
  const cwd = str(profile.cwd) === '' ? serverCwd : resolve(serverCwd, home(str(profile.cwd)));
  const named = [str(profile.model), str(profile.mmproj), ...arr(profile.args).map((a) => str(a))].filter((f) =>
    f.endsWith('.gguf'),
  );
  const files = new Set<string>();
  for (const f of named) {
    const file = resolve(cwd, home(f));
    // A split model: its first shard is named, llama-server opens them all.
    const split = /-\d{5}-of-(\d{5})\.gguf$/.exec(file);
    if (split && existsSync(dirname(file))) {
      const stem = basename(file).slice(0, -split[0].length);
      for (const s of readdirSync(dirname(file)))
        if (s.startsWith(`${stem}-`) && s.endsWith(`-of-${split[1] ?? ''}.gguf`)) files.add(join(dirname(file), s));
    } else files.add(file);
  }
  return [...files].filter((f) => existsSync(f));
}

/** The share of the files' bytes in the page cache, in % (`fincore`), null when it cannot be read. */
export function residentPct(files: string[]): number | null {
  if (files.length === 0) return null;
  try {
    const out = execFileSync('fincore', ['--bytes', '--noheadings', '--raw', '--output', 'RES,SIZE', ...files], {
      encoding: 'utf8',
    });
    let res = 0;
    let size = 0;
    for (const line of out.trim().split('\n')) {
      const [r, s] = line.trim().split(/\s+/).map(Number);
      res += r ?? 0;
      size += s ?? 0;
    }
    // fincore rounds a partial last page up.
    return size > 0 ? Math.min(100, (res / size) * 100) : null;
  } catch {
    return null;
  }
}

/** Drops the files' pages from the page cache; false when `dd` refused. */
export function evict(files: string[]): boolean {
  try {
    for (const f of files) execFileSync('dd', [`if=${f}`, 'iflag=nocache', 'count=0', 'status=none']);
    return true;
  } catch {
    return false;
  }
}
