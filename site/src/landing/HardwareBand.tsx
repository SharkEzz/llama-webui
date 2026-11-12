/** README "Requirements" and the collectors (server/collectors/). */
const GROUPS = [
  ['NVIDIA GPUs', 'Telemetry through NVML, with nvidia-smi as a fallback.'],
  ['AMD GPUs', 'Telemetry through the amdgpu driver in sysfs.'],
  ['Any llama.cpp backend', 'CUDA, Vulkan, ROCm or CPU builds, one model split across them.'],
  ['Linux, one Node.js process', 'Hardware is read from /proc and /sys. One npm package to install, from a release.'],
] as const;

export function HardwareBand() {
  return (
    <section aria-labelledby="hardware-title" className="border-y border-border bg-card/40">
      <div className="mx-auto grid max-w-6xl gap-10 px-6 py-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,3fr)] lg:gap-16">
        <h2 id="hardware-title" className="max-w-[16ch] text-2xl font-semibold tracking-tight text-balance">
          Runs on the hardware you already have.
        </h2>
        <dl className="grid gap-x-10 gap-y-6 sm:grid-cols-2">
          {GROUPS.map(([title, text]) => (
            <div key={title}>
              <dt className="font-medium">{title}</dt>
              <dd className="mt-1 text-sm text-muted-foreground text-pretty">{text}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
