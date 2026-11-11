/** `llama-bench` output: its JSON report (`-o json`), its `--progress` lines and its `--list-devices` table. */

/** One measure: mean tokens/s, its standard deviation, and the tokens per run. */
export interface BenchMeasure {
  tps: number;
  stddev: number;
  tokens: number;
}

/** A device of `--list-devices`. */
export interface BenchDevice {
  id: string;
  name: string;
  totalMib: number;
  freeMib: number;
  /** Letters of the id: "CUDA", "Vulkan", "BLAS"… */
  backend: string;
}

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
): { pp: BenchMeasure | null; tg: BenchMeasure | null; build: string | null } | null {
  let entries: unknown;
  try {
    entries = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(entries) || entries.length === 0) return null;
  let pp: BenchMeasure | null = null;
  let tg: BenchMeasure | null = null;
  let build: string | null = null;
  // model_filename is badly encoded by llama-bench (the path's UTF-8 is broken): never read.
  for (const e of entries as BenchJsonEntry[]) {
    const np = e.n_prompt ?? 0;
    const ng = e.n_gen ?? 0;
    const m = (tokens: number): BenchMeasure => ({ tps: e.avg_ts ?? 0, stddev: e.stddev_ts ?? 0, tokens });
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

/**
 * A line of llama.cpp's output (llama-bench, llama-server) that says why it stopped: an allocation failure, a CUDA
 * error, an `error:` or a C++ exception.
 */
export const ERROR_LINE =
  /out of memory|failed to allocate|unable to allocate|CUDA error|\berror( loading [^:]*)?:|what\(\):/i;

/** A line that reports an allocation failure (device or host memory). */
export const OOM_LINE = /out of memory|failed to allocate|unable to allocate/i;
