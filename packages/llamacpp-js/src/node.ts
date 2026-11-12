/**
 * What needs the machine rather than HTTP: running the binaries, finding their paths and processes. Node APIs only
 * (`node:child_process`, `node:fs`, `node:path`), so it runs in Node ≥ 24, not in a browser.
 */
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { type FlagCatalog, parseHelp } from './flags.ts';

/** The arguments of a `/proc/<pid>/cmdline` (NUL-separated). */
export function parseCmdline(raw: string): string[] {
  return raw.split('\0').filter((s) => s.length > 0);
}

/** The `--port` of a llama-server command line; 8080, its default, when it has none. */
export function portFromArgv(argv: string[]): number {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--port' && argv[i + 1] !== undefined) return Number(argv[i + 1]);
    if (a.startsWith('--port=')) return Number(a.slice(7));
  }
  return 8080;
}

/** The pid of the `llama-server` process listening on `port`, from `/proc` (Linux); null when there is none. */
export async function findLlamaServerPid(port: number, procRoot = '/proc'): Promise<number | null> {
  let entries: string[];
  try {
    entries = await readdir(procRoot);
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    let raw: string;
    try {
      raw = await readFile(join(procRoot, e, 'cmdline'), 'utf8');
    } catch {
      continue;
    }
    const argv = parseCmdline(raw);
    if (argv[0] && basename(argv[0]) === 'llama-server' && portFromArgv(argv) === port) return Number(e);
  }
  return null;
}

/** The flag catalogue of a llama.cpp binary, from its `--help`; null when it cannot run, fails, or lists no flag. */
export function loadFlags(binary: string, timeoutMs = 5000): Promise<FlagCatalog | null> {
  return new Promise((resolve) => {
    execFile(
      binary,
      ['--help'],
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout) => {
        if (err) return resolve(null);
        const catalog = parseHelp(stdout);
        resolve(catalog.flags.length > 0 ? catalog : null);
      },
    );
  });
}

/** llama-bench next to a llama-server binary (bare name → bare name, looked up in the PATH). */
export function benchBinary(serverBinary: string): string {
  const name = basename(serverBinary).replace('llama-server', 'llama-bench');
  return serverBinary.includes('/') ? join(dirname(serverBinary), name) : name;
}
