import { GlassCard } from './GlassCard';

/** README "Requirements" and the collectors (server/collectors/). */
const GROUPS = [
  ['NVIDIA GPUs', 'Telemetry through NVML, with nvidia-smi as a fallback.'],
  ['AMD GPUs', 'Telemetry through the amdgpu driver in sysfs.'],
  ['Any llama.cpp backend', 'CUDA, Vulkan, ROCm or CPU builds, one model split across them.'],
  ['Linux, one Node.js process', 'Hardware is read from /proc and /sys. One npm package to install, from a release.'],
] as const;

export function HardwareBand() {
  return (
    <section aria-labelledby="hardware-title" className="mx-auto max-w-6xl px-6 py-12">
      <GlassCard as="div" className="rounded-3xl p-7 sm:p-10">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,2.5fr)] lg:gap-12">
          <h2
            id="hardware-title"
            className="max-w-[16ch] text-2xl font-semibold tracking-tight text-balance sm:text-3xl"
          >
            Runs on the hardware you already have.
          </h2>
          <dl className="grid gap-4 sm:grid-cols-2">
            {GROUPS.map(([title, text]) => (
              <div key={title} className="rounded-xl bg-well p-4 ring-1 ring-border">
                <dt className="text-sm font-medium">{title}</dt>
                <dd className="mt-1 text-sm text-pretty text-muted-foreground">{text}</dd>
              </div>
            ))}
          </dl>
        </div>
      </GlassCard>
    </section>
  );
}
