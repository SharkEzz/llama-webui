import { Gauge } from 'lucide-react';
import { Shot } from '@/components/Shot';
import { BentoCard, FeatureSection, SHOT_FRAME } from '../Bento';

/** Run #5 of the demo instance: a server run started from the 27B profile. */
const RUN = {
  flags: '-ngl 99 -dev CUDA0,CUDA1 -ts 51,58 -sm tensor -fa on -c 32768 --spec-type draft-mtp',
  stats: [
    ['Prompt', '1,098.7 tok/s'],
    ['Generation', '75.0 tok/s'],
    ['Draft accepted', '54.9%'],
    ['Peak VRAM', '16.68 GiB'],
  ],
} as const;

export function BenchmarkSection() {
  return (
    <FeatureSection
      id="benchmark"
      tone="teal"
      pages={[{ label: 'Benchmark', icon: Gauge, doc: '/docs/benchmark/' }]}
      title="Measure the server you will actually run."
      lede="Benchmark raw llama.cpp speed, or a real llama-server with your profile's context and speculative decoding. Every run is kept, so you can compare them side by side."
    >
      <BentoCard
        className="lg:col-span-6"
        title="A history of every run"
        visual={
          <Shot
            name="benchmark"
            alt="Benchmark history: five runs with their tool, flags, prompt and generation speed, draft acceptance, peak VRAM and duration"
            crop={{ x: 0.16, y: 0.585, w: 0.835, h: 0.39 }}
            width="min(68rem, 90vw)"
            className={SHOT_FRAME}
          />
        }
      >
        Each run is either llama-bench, the raw llama.cpp measurement, or a real llama-server: a warm-up, then chat
        requests. Every run keeps its command, the hardware and the llama.cpp build.
      </BentoCard>

      <BentoCard
        className="lg:col-span-3"
        title="Compare runs"
        visual={
          <Shot
            name="benchmark-compare"
            alt="Comparison of two runs: the split mode differs (layer against tensor), with prompt and generation speed and VRAM"
            crop={{ x: 0.18, y: 0.05, w: 0.645 }}
            width="min(34rem, 90vw)"
            fade
            className={`${SHOT_FRAME} aspect-square flex-1 lg:aspect-auto lg:min-h-80`}
          />
        }
      >
        Pick up to four runs: every flag and result side by side, with the values that differ highlighted.
      </BentoCard>

      <BentoCard
        className="lg:col-span-3"
        title="Turn any run into a profile"
        visual={
          <div className="mx-6 mb-6 flex flex-1 flex-col gap-4 rounded-xl border border-border p-4">
            <p className="text-sm font-medium">
              Run #5 <span className="font-normal text-muted-foreground">on llama-server</span>
            </p>
            <code className="rounded-lg bg-muted px-3 py-2.5 font-mono text-xs leading-relaxed text-pretty">
              {RUN.flags}
            </code>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
              {RUN.stats.map(([label, value]) => (
                <div key={label}>
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd className="num text-lg whitespace-nowrap">{value}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-auto flex justify-end gap-2 text-sm font-medium" aria-hidden="true">
              <span className="inline-flex h-8 items-center rounded-lg border border-border px-3">Rerun</span>
              <span className="inline-flex h-8 items-center rounded-lg bg-primary px-3 text-primary-foreground">
                Create profile
              </span>
            </div>
          </div>
        }
      >
        The flags you measured become a profile in one click, ready for the launch pad.
      </BentoCard>
    </FeatureSection>
  );
}
