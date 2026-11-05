import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";

export function parseCmdline(raw: string): string[] {
  return raw.split("\0").filter((s) => s.length > 0);
}

export function portFromArgv(argv: string[]): number {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--port" && argv[i + 1] !== undefined) return Number(argv[i + 1]);
    if (a.startsWith("--port=")) return Number(a.slice(7));
  }
  return 8080;
}

export async function findLlamaServerPid(port: number, procRoot = "/proc"): Promise<number | null> {
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
      raw = await Bun.file(join(procRoot, e, "cmdline")).text();
    } catch {
      continue;
    }
    const argv = parseCmdline(raw);
    if (argv[0] && basename(argv[0]) === "llama-server" && portFromArgv(argv) === port) return Number(e);
  }
  return null;
}
