import { CircleCheck, TriangleAlert, Wand2 } from 'lucide-react';
import { Shot } from '@/components/Shot';
import { cn } from '@/lib/utils';
import { BentoCard, FeatureSection, SHOT_FRAME } from '../Bento';

/**
 * Output of the app's estimator (server/tuning/estimate.ts) for the "Responsive chat" preset, run on the real GGUF of
 * Qwen3.8 Flash-Next IQ3_XXS (70.6 GiB) with the hardware fixture hw3: RTX 5070 Ti and RTX 5060 Ti on CUDA, Radeon
 * RX 9070 XT on Vulkan, 61 GiB of RAM. -b / -ub (default) left out.
 */
const ROWS = [
  ['-ngl', '43', '43 of 48 layers fit, the rest in RAM'],
  ['-dev', 'CUDA0,CUDA1,Vulkan3', '3 cards, CUDA0 gets the compute buffers'],
  ['-ts', '55,58,59', 'split by the usable VRAM of each card'],
  ['-c', '32768', '72.2 GiB estimated in total, f16 KV cache included, margin kept'],
  ['-fa', 'on', 'faster attention, smaller compute buffers'],
  ['-ctk / -ctv', 'f16', 'the budget allows it, no loss'],
  ['-t', '6', '6 physical cores'],
  ['--fit', 'off', 'what gets measured is exactly what gets written'],
  ['--mlock', '', 'whole model locked in memory, enough RAM'],
] as const;

/** Same estimate: GiB used, usable budget (headroom deducted) and total, per device then RAM. */
const BARS = [
  { device: 'CUDA0', used: 11.65, budget: 14.44, total: 15.56 },
  { device: 'CUDA1', used: 14.2, budget: 14.44, total: 15.57 },
  { device: 'Vulkan3', used: 14.51, budget: 14.78, total: 15.92 },
  { device: 'RAM', used: 31.84, budget: 55, total: 61 },
] as const;

/** packages/webui-shared/src/tuning.ts */
const PRESETS = [
  ['Responsive chat', 'generation throughput first, 32k context'],
  ['Agent & RAG', 'long prompts: prompt processing and generation'],
  ['Max context', 'the largest context that fits, then generation'],
  ['Make the model fit', 'get it to start and reply, even slowly'],
  ['100 GB model', 'MoE experts in RAM, attention and norms on all cards'],
] as const;

const gib = (n: number) => `${n.toFixed(1)} GiB`;

function Recommendation() {
  return (
    <div className="mx-6 mb-6 grid gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <table className="w-full text-xs max-sm:block">
        <thead className="max-sm:hidden">
          <tr className="border-b border-border text-left">
            <th className="h-9 pr-3 font-medium">Flag</th>
            <th className="h-9 pr-3 font-medium">Value</th>
            <th className="h-9 font-medium">Why</th>
          </tr>
        </thead>
        <tbody className="max-sm:block">
          {ROWS.map(([flag, value, why]) => (
            <tr
              key={flag}
              className="border-b border-border last:border-0 max-sm:grid max-sm:grid-cols-[auto_1fr] max-sm:py-1.5"
            >
              <td className="py-2 pr-3 align-top font-mono whitespace-nowrap">{flag}</td>
              <td className="py-2 pr-3 align-top font-mono whitespace-nowrap">{value}</td>
              <td className="py-2 align-top text-muted-foreground max-sm:col-span-2 max-sm:pt-0">{why}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex flex-col gap-3">
        {BARS.map((b) => {
          const tight = b.used > 0.95 * b.budget;
          const ram = b.device === 'RAM';
          return (
            <div key={b.device} className="flex flex-col gap-1.5">
              <div className="flex items-baseline gap-2 text-sm">
                <span className="font-mono font-medium">{b.device}</span>
                <span className="num ml-auto text-xs whitespace-nowrap">
                  {gib(b.used)}{' '}
                  <span className="text-muted-foreground">
                    / {gib(b.budget)} {ram ? 'available' : 'usable'}
                  </span>
                </span>
              </div>
              <div className="relative h-2 rounded-full bg-muted">
                <div
                  className={cn('absolute inset-y-0 left-0 rounded-full', tight ? 'bg-warning' : 'bg-chart-1')}
                  style={{ width: `${(100 * b.used) / b.total}%` }}
                />
                <div
                  className="absolute -inset-y-0.5 w-0.5 rounded-full bg-foreground/60"
                  style={{ left: `${(100 * b.budget) / b.total}%` }}
                />
              </div>
              {tight && (
                <p className="flex items-center gap-1 text-xs text-warning">
                  <TriangleAlert className="size-3.5" aria-hidden="true" />
                  tight: less than 5% headroom
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Presets() {
  return (
    <ul className="mx-6 mb-6 flex flex-col gap-1.5">
      {PRESETS.map(([label, hint], i) => (
        <li
          key={label}
          className={cn(
            'rounded-lg border px-3 py-2',
            i === 0 ? 'border-primary/60 bg-primary/8' : 'border-border text-muted-foreground',
          )}
        >
          <span className={cn('block text-sm font-medium', i === 0 && 'text-foreground')}>{label}</span>
          <span className="block text-xs text-muted-foreground">{hint}</span>
        </li>
      ))}
    </ul>
  );
}

function Checks() {
  return (
    <div className="mx-6 mb-6 flex flex-col gap-3 text-sm">
      <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
        <div className="flex items-center gap-2">
          <TriangleAlert className="size-4 shrink-0 text-warning" aria-label="Warning" />
          <span className="font-medium">CPU governor</span>
          <span className="ml-auto font-mono text-xs text-muted-foreground">powersave</span>
        </div>
        <p className="text-xs text-muted-foreground">slower prompt processing and CPU offload</p>
        <code className="rounded-md bg-muted px-2.5 py-2 font-mono text-[11px] leading-relaxed break-all">
          echo performance | sudo tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor
        </code>
      </div>
      {[
        ['Persistence NVIDIA GeForce RTX 5070 Ti', 'enabled'],
        ['Module nvidia_uvm', 'loaded'],
        ['Transparent hugepages', 'madvise'],
      ].map(([label, detail]) => (
        <div key={label} className="flex items-center gap-2 px-3">
          <CircleCheck className="size-4 shrink-0 text-success" aria-label="OK" />
          <span className="truncate">{label}</span>
          <span className="ml-auto font-mono text-xs text-muted-foreground">{detail}</span>
        </div>
      ))}
      <p className="px-3 text-xs text-muted-foreground">
        Also: power limit, PCIe link, Resizable BAR, AMD DPM, swappiness, memlock, IOMMU, model disk speed.
      </p>
    </div>
  );
}

const STEPS = [
  [
    'Explore',
    'Every combination of the values you list (devices, splits, cache types, -ot patterns) that the estimator says fits, run one after the other with llama-bench. A restart resumes where it stopped.',
  ],
  ['Validate', 'The best candidates run again on a real llama-server.'],
  ['Keep', 'The winner becomes a profile, ready to start from the launch pad.'],
] as const;

export function TuningSection() {
  return (
    <FeatureSection
      id="tuning"
      tone="amber"
      pages={[{ label: 'Tuning', icon: Wand2, doc: '/docs/tuning/' }]}
      title="Get flags that fit your hardware."
      lede="Choose a goal. llama-webui reads your GPUs, RAM and CPU, recommends every flag with the reason behind it, then backs it up with benchmarks."
    >
      <BentoCard className="lg:col-span-6" title="Every flag comes with a reason" visual={<Recommendation />}>
        Responsive chat for a 70.6 GiB model on an RTX 5070 Ti, an RTX 5060 Ti and a Radeon RX 9070 XT. The estimator
        keeps 5 of 48 layers in RAM and flags the cards with a thin margin.
      </BentoCard>

      <BentoCard className="lg:col-span-3" title="Pick a goal" visual={<Presets />}>
        Each preset sets the target context, the KV cache type and what the ranking favors.
      </BentoCard>

      <BentoCard className="lg:col-span-3" title="Check the system" visual={<Checks />}>
        A read-only list of what slows llama.cpp down on this machine, each with the command that fixes it.
      </BentoCard>

      <BentoCard
        side
        className="lg:col-span-6"
        title="Sweeps settle it with measurements"
        details={
          <ol className="mt-6 flex flex-col gap-5">
            {STEPS.map(([name, text], i) => (
              <li key={name} className="grid grid-cols-[1.75rem_1fr] gap-x-3">
                <span className="num flex size-7 items-center justify-center rounded-full bg-tone-amber/15 text-xs font-medium text-tone-amber">
                  {i + 1}
                </span>
                <div>
                  <p className="text-sm font-medium">{name}</p>
                  <p className="mt-0.5 text-sm text-muted-foreground text-pretty">{text}</p>
                </div>
              </li>
            ))}
          </ol>
        }
        visual={
          <Shot
            name="tuning-sweep"
            alt="A finished sweep: validation on the server, then the exploration ranking with prompt and generation speed and peak VRAM"
            crop={{ x: 0.16, y: 0.1, w: 0.83 }}
            width="min(42rem, 90vw)"
            fade
            className={`${SHOT_FRAME} aspect-[3/2] flex-1 lg:aspect-auto lg:min-h-96`}
          />
        }
      >
        When the estimate leaves a choice open, a sweep measures it.
      </BentoCard>
    </FeatureSection>
  );
}
