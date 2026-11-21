import { type BenchRun, benchArgs, type Measure, serverArgs, shellQuote } from '@llama-webui/shared';
import { fmt, formatRate, formatStddev } from '@/lib/format';

/** File name without directory or `.gguf`. */
export const modelName = (path: string) => (path.split('/').pop() ?? path).replace(/\.gguf$/, '');

/** The run's flags in its tool's syntax (plus the extra flags for a server run). */
export function flagsOf(run: BenchRun): string {
  const s = run.spec;
  const args = s.kind === 'bench' ? benchArgs(s.params) : [...serverArgs(s.params), ...s.serverArgs];
  return args.length > 0 ? shellQuote(args) : 'defaults';
}

/** “51.2 tok/s ± 0.4”. */
export function formatMeasure(m: Measure | null): string {
  if (!m) return '—';
  return `${formatRate(m.tps)}${formatStddev(m.stddev)}`;
}

/** Sum of the VRAM peaks, in GiB. */
export function vramTotal(run: BenchRun): string {
  const mib = run.vramPeak.reduce((a, v) => a + v.mib, 0);
  return mib === 0 ? '—' : formatMib(mib);
}

/** “985 MiB” under 1 GiB, otherwise “17.52 GiB”. */
export const formatMib = (mib: number) => (mib < 1024 ? `${Math.round(mib)} MiB` : `${fmt(mib / 1024, 2)} GiB`);

/** Draft acceptance rate (“47.5%”), “—” without speculative decoding. */
export const formatAccept = (pct: number | null) => (pct === null ? '—' : `${fmt(pct, 1)}%`);
