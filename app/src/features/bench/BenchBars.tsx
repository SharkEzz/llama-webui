import type { BenchRun, Measure } from '@llama-webui/shared';
import { TONE_VAR, type Tone } from '@/components/glass/tones';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { KIND_LABEL } from '@/lib/bench';
import { fmt } from '@/lib/format';
import { formatMeasure } from './format';

/** Fixed tone order: the color follows the run's position in the comparison, never its rank. */
export const RUN_TONES: Tone[] = ['blue', 'teal', 'amber', 'rose'];

/** pp and tg throughput of the compared runs: two small bar charts, each on its own scale (no dual axis). */
export function BenchBars({ runs }: { runs: BenchRun[] }) {
  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Legend">
        {runs.map((r, i) => (
          <li key={r.id} className="flex items-center gap-1.5">
            <span
              className="size-2.5 rounded-[3px]"
              style={{ background: TONE_VAR[RUN_TONES[i % RUN_TONES.length]!] }}
              aria-hidden="true"
            />
            #{r.id} · {KIND_LABEL[r.kind]}
          </li>
        ))}
      </ul>
      <div className="grid gap-6 md:grid-cols-2">
        <Panel title="Prompt (tok/s)" runs={runs} pick={(r) => r.pp} />
        <Panel title="Generation (tok/s)" runs={runs} pick={(r) => r.tg} />
      </div>
    </div>
  );
}

function Panel({ title, runs, pick }: { title: string; runs: BenchRun[]; pick(r: BenchRun): Measure | null }) {
  const max = Math.max(1, ...runs.map((r) => pick(r)?.tps ?? 0));
  return (
    <figure className="flex flex-col gap-2">
      <figcaption className="text-sm font-medium">{title}</figcaption>
      <div className="flex flex-col gap-0.5">
        {runs.map((r, i) => {
          const m = pick(r);
          const pct = m ? (m.tps / max) * 100 : 0;
          return (
            <Tooltip key={r.id}>
              <TooltipTrigger
                render={<div />}
                className="grid grid-cols-[2.5rem_minmax(0,1fr)_7.5rem] items-center gap-2 rounded-sm py-1 hover:bg-muted/60"
                aria-label={`Run #${r.id}: ${formatMeasure(m)}`}
              >
                <span className="num text-xs text-muted-foreground">#{r.id}</span>
                <span className="h-3 w-full">
                  {m && (
                    <span
                      className="block h-full rounded-r-[4px]"
                      style={{
                        width: `${Math.max(pct, 0.5)}%`,
                        background: TONE_VAR[RUN_TONES[i % RUN_TONES.length]!],
                      }}
                    />
                  )}
                </span>
                <span className="num text-right text-xs">{m ? fmt(m.tps, 1) : '—'}</span>
              </TooltipTrigger>
              <TooltipContent>
                #{r.id} · {KIND_LABEL[r.kind]}: {formatMeasure(m)}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </figure>
  );
}
