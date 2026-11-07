import { basename, dirname, join } from 'node:path';
import { type BenchDevice, type Measure, OOM_ERROR } from '@llama-webui/shared';

interface BenchJsonEntry {
  n_prompt?: number;
  n_gen?: number;
  avg_ts?: number;
  stddev_ts?: number;
  build_number?: number;
  build_commit?: string;
}

/** pp and tg from a `llama-bench -o json` output; null if the JSON is missing or truncated (loading failed). */
export function parseBenchJson(
  stdout: string,
): { pp: Measure | null; tg: Measure | null; build: string | null } | null {
  let entries: unknown;
  try {
    entries = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(entries) || entries.length === 0) return null;
  let pp: Measure | null = null;
  let tg: Measure | null = null;
  let build: string | null = null;
  // model_filename is badly encoded by llama-bench (the path's UTF-8 is broken): never read.
  for (const e of entries as BenchJsonEntry[]) {
    const np = e.n_prompt ?? 0;
    const ng = e.n_gen ?? 0;
    const m = (tokens: number): Measure => ({ tps: e.avg_ts ?? 0, stddev: e.stddev_ts ?? 0, tokens });
    if (np > 0 && ng === 0) pp = m(np);
    else if (ng > 0 && np === 0) tg = m(ng);
    if (build === null && e.build_number !== undefined)
      build = `b${e.build_number}${e.build_commit ? ` (${e.build_commit})` : ''}`;
  }
  return { pp, tg, build };
}

const PROGRESS = /^llama-bench: benchmark (\d+)\/(\d+): (warmup|prompt|generation)(?: \w+)? run(?: (\d+)\/(\d+))?/;

/** A `--progress` line (stderr): `llama-bench: benchmark 1/2: prompt run 2/2`. */
export function parseBenchProgress(line: string): {
  phase: 'warmup' | 'prompt' | 'generation';
  test: number;
  tests: number;
  run: number | null;
  runs: number | null;
} | null {
  const m = PROGRESS.exec(line.trim());
  if (!m) return null;
  return {
    phase: m[3] as 'warmup' | 'prompt' | 'generation',
    test: Number(m[1]),
    tests: Number(m[2]),
    run: m[4] ? Number(m[4]) : null,
    runs: m[5] ? Number(m[5]) : null,
  };
}

const DEVICE = /^\s+(\S+): (.+) \((\d+) MiB, (\d+) MiB free\)\s*$/;

/** The output of `llama-bench --list-devices`. */
export function parseDeviceList(text: string): BenchDevice[] {
  const out: BenchDevice[] = [];
  for (const line of text.split('\n')) {
    const m = DEVICE.exec(line);
    if (m)
      out.push({
        id: m[1]!,
        name: m[2]!,
        totalMib: Number(m[3]),
        freeMib: Number(m[4]),
        backend: m[1]!.replace(/\d+$/, ''),
      });
  }
  return out;
}

/** A line that says why the tool stopped (copied from llama-tui, + “unable to allocate”). */
export const ERROR_LINE =
  /out of memory|failed to allocate|unable to allocate|CUDA error|\berror( loading [^:]*)?:|what\(\):/i;
const OOM = /out of memory|failed to allocate|unable to allocate/i;

/** Why a run failed, based on the tool's last lines. */
export function benchFailure(
  lines: string[],
  exit: number | string,
  tool = 'llama-bench',
): { message: string; oom: boolean } {
  const oom = lines.some((l) => OOM.test(l));
  // OOM: the allocation line (“unable to allocate CUDA1 buffer”) rather than the “failed to load model” that follows.
  const line = [...lines]
    .reverse()
    .find((l) => (oom ? OOM : ERROR_LINE).test(l))
    ?.trim();
  if (!line) return { oom, message: oom ? OOM_ERROR : `${tool} exited (code ${exit})` };
  return { oom, message: oom ? `${OOM_ERROR}: ${line}` : line };
}

/** llama-bench next to the server binary from the settings (bare name → bare name, looked up in the PATH). */
export function benchBinary(serverBinary: string): string {
  const name = basename(serverBinary).replace('llama-server', 'llama-bench');
  return serverBinary.includes('/') ? join(dirname(serverBinary), name) : name;
}
