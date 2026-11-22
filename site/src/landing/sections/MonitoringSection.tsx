import { Activity, Cpu, Network, ScrollText } from 'lucide-react';
import { Shot } from '@/components/Shot';
import { type AppPage, BentoCard, PageChips, SectionHalo, SHOT_FRAME } from '../Bento';

const PAGES: AppPage[] = [
  { label: 'Dashboard', icon: Activity, doc: '/docs/dashboard/' },
  { label: 'System', icon: Cpu, doc: '/docs/system/' },
  { label: 'Topology', icon: Network, doc: '/docs/topology/' },
  { label: 'Logs', icon: ScrollText, doc: '/docs/logs/' },
];

/** What the Topology page shows (app/src/features/topology/). */
const HUD = [
  ['Phase', 'loading, prompt or generation, with the current speeds'],
  ['Model split', 'memory per device and offloaded layers, from the startup logs'],
  ['Tanks', 'each GPU filled to its VRAM: model, KV cache, compute buffers'],
  ['Links', 'exact throughput per direction, and an alert near the PCIe capacity'],
] as const;

/** Where each reading comes from (server/collectors/). */
const SOURCES = [
  ['NVIDIA GPUs', 'NVML, or nvidia-smi as a fallback'],
  ['AMD GPUs', 'the amdgpu driver, through sysfs'],
  ['CPU, RAM and disks', '/proc and /sys'],
  ['DRAM bandwidth', 'perf, on AMD Zen 4 and Zen 5'],
  ['Tokens and slots', "llama-server's /metrics and /slots"],
] as const;

export function MonitoringSection() {
  return (
    <section
      id="monitoring"
      aria-labelledby="monitoring-title"
      className="relative isolate mx-auto max-w-6xl px-6 py-24 sm:py-28"
    >
      <SectionHalo tone="blue" />
      <div className="grid gap-12 lg:grid-cols-[minmax(0,4.4fr)_minmax(0,7.6fr)] lg:items-start">
        <div className="lg:sticky lg:top-28">
          <PageChips pages={PAGES} tone="blue" />
          <h2
            id="monitoring-title"
            className="mt-5 max-w-[16ch] text-4xl font-semibold tracking-[-0.035em] text-balance sm:text-5xl"
          >
            See what every GPU is doing.
          </h2>
          <p className="mt-4 max-w-[44ch] text-lg text-pretty text-muted-foreground">
            Throughput, VRAM, PCIe traffic, power and temperatures, read from the real hardware every second while
            llama-server works.
          </p>
        </div>

        <div className="flex flex-col gap-5">
          <BentoCard
            tone="blue"
            title="Your machine, in 3D"
            details={
              <dl className="mt-5 grid gap-x-5 gap-y-3 text-sm sm:grid-cols-2">
                {HUD.map(([what, text]) => (
                  <div key={what} className="border-l-2 border-tone-blue/55 pl-3">
                    <dt className="font-medium">{what}</dt>
                    <dd className="text-xs leading-relaxed text-muted-foreground">{text}</dd>
                  </div>
                ))}
              </dl>
            }
            visual={
              <Shot
                name="topology"
                alt="Topology page: the CPU, memory, GPUs and NVMe drive as 3D blocks, the GPUs filled to the memory they hold, with the model split per device"
                crop={{ x: 0.155, y: 0.055, w: 0.84, h: 0.935 }}
                width="min(46rem, 90vw)"
                className={SHOT_FRAME}
              />
            }
          >
            CPU, memory, NVMe drives and GPUs are discovered from sysfs. Streaks follow the measured PCIe, NVMe and DRAM
            traffic, and each GPU fills up with what the model takes in it.
          </BentoCard>

          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <BentoCard
              tone="blue"
              title="One card per GPU"
              visual={
                <Shot
                  name="system"
                  alt="System page: utilization, VRAM, PCIe link and traffic, power, clocks, temperature and fan of an RTX 5070 Ti"
                  crop={{ x: 0.16, y: 0.115, w: 0.42 }}
                  width="min(24rem, 90vw)"
                  fade
                  className={`${SHOT_FRAME} min-h-68 flex-1`}
                />
              }
            >
              Utilization, VRAM, PCIe link and traffic, power, clocks, temperature and fans, for NVIDIA and AMD cards.
            </BentoCard>

            <BentoCard
              tone="blue"
              title="Read from the drivers"
              visual={
                <dl className="mx-6 mb-6 divide-y divide-border text-sm">
                  {SOURCES.map(([what, from]) => (
                    <div key={what} className="flex flex-col gap-0.5 py-2.5 first:pt-0 last:pb-0">
                      <dt className="font-medium">{what}</dt>
                      <dd className="text-muted-foreground">{from}</dd>
                    </div>
                  ))}
                </dl>
              }
            >
              Nothing is estimated on the monitoring pages.
            </BentoCard>
          </div>

          <BentoCard
            side
            tone="blue"
            title="Live logs"
            visual={
              <Shot
                name="logs"
                alt="Logs page: level filter, search, auto-follow and llama-server lines"
                crop={{ x: 0.15, y: 0.07, w: 0.5 }}
                width="min(28rem, 90vw)"
                fade
                className={`${SHOT_FRAME} min-h-56 flex-1`}
              />
            }
          >
            The last 10,000 lines of llama-server, with a level filter, search and auto-follow.
          </BentoCard>
        </div>
      </div>
    </section>
  );
}
