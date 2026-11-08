import { Activity, Cpu, Network, ScrollText } from 'lucide-react';
import { Shot } from '@/components/Shot';
import { BentoCard, FeatureSection, SHOT_FRAME } from '../Bento';

/** What the Topology HUD shows (web/src/features/topology/Hud.tsx). */
const HUD = [
  ['Phase', 'loading, prompt or generation, with the current speeds'],
  ['Model split', 'memory per device and offloaded layers, from the startup logs'],
  ['Throughput', 'host to GPU and back, NVMe reads, DRAM reads and writes'],
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
    <FeatureSection
      id="monitoring"
      tone="blue"
      pages={[
        { label: 'Dashboard', icon: Activity, doc: '/docs/dashboard/' },
        { label: 'System', icon: Cpu, doc: '/docs/system/' },
        { label: 'Topology', icon: Network, doc: '/docs/topology/' },
        { label: 'Logs', icon: ScrollText, doc: '/docs/logs/' },
      ]}
      title="See what every GPU is doing."
      lede="Throughput, VRAM, PCIe traffic, power and temperatures, read from the real hardware every second while llama-server works."
    >
      <BentoCard
        side
        className="lg:col-span-6"
        title="Your machine, in 3D"
        details={
          <dl className="mt-6 flex flex-col gap-3 text-sm">
            {HUD.map(([what, text]) => (
              <div key={what} className="border-l-2 border-tone-blue/50 pl-3">
                <dt className="font-medium">{what}</dt>
                <dd className="text-muted-foreground">{text}</dd>
              </div>
            ))}
          </dl>
        }
        visual={
          <Shot
            name="topology"
            alt="Topology page: the CPU, memory, GPUs and NVMe drive as 3D blocks, with the model split per device"
            crop={{ x: 0.155, y: 0.055, w: 0.84, h: 0.935 }}
            width="min(42rem, 90vw)"
            className={SHOT_FRAME}
          />
        }
      >
        CPU, memory, NVMe drives and GPUs are discovered from sysfs. Particles follow the measured PCIe, NVMe and DRAM
        traffic, and the HUD shows how the model is split across devices.
      </BentoCard>

      <BentoCard
        className="lg:col-span-2"
        title="One card per GPU"
        visual={
          <Shot
            name="system"
            alt="System page: utilization, VRAM, PCIe link and traffic, power, clocks, temperature and fan of an RTX 5070 Ti"
            crop={{ x: 0.16, y: 0.115, w: 0.42 }}
            width="min(22rem, 90vw)"
            fade
            className={`${SHOT_FRAME} min-h-72 flex-1`}
          />
        }
      >
        Utilization, VRAM, PCIe link and traffic, power, clocks, temperature and fans, for NVIDIA and AMD cards.
      </BentoCard>

      <BentoCard
        className="lg:col-span-2"
        title="Read from the drivers"
        visual={
          <dl className="mx-6 mb-6 divide-y divide-border text-sm">
            {SOURCES.map(([what, from]) => (
              <div key={what} className="flex flex-col gap-0.5 py-2.5 first:pt-0">
                <dt className="font-medium">{what}</dt>
                <dd className="text-muted-foreground">{from}</dd>
              </div>
            ))}
          </dl>
        }
      >
        Nothing is estimated on the monitoring pages.
      </BentoCard>

      <BentoCard
        className="lg:col-span-2"
        title="Live logs"
        visual={
          <Shot
            name="logs"
            alt="Logs page: level filter, search, auto-follow and llama-server lines"
            crop={{ x: 0.15, y: 0.07, w: 0.5 }}
            width="min(22rem, 90vw)"
            fade
            className={`${SHOT_FRAME} min-h-72 flex-1`}
          />
        }
      >
        The last 10,000 lines of llama-server, with a level filter, search and auto-follow.
      </BentoCard>
    </FeatureSection>
  );
}
