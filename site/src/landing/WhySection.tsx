import { cn } from '@/lib/utils';

/** README "Why llama-webui?" */
const PILLARS = [
  [
    'One process, one port.',
    'API, WebSocket and UI are served by one Node.js process on port 7860. No database server: everything lives in a SQLite file.',
  ],
  [
    'Mixed hardware.',
    'NVIDIA (NVML), AMD (sysfs) and CPU are first-class, including multi-GPU setups mixing CUDA and Vulkan or ROCm devices.',
  ],
  [
    'Measured, not guessed.',
    'Throughput, VRAM, PCIe traffic, disk reads and DRAM bandwidth come from the real server and the real hardware, and tuning recommendations are validated by actual benchmark runs.',
  ],
] as const;

type Line = { kind: 'cmd' | 'out' | 'err'; text: string };

/** A first try at fitting a 70 GB model on three cards. Error lines as llama.cpp prints them. */
const SESSION: Line[] = [
  {
    kind: 'cmd',
    text: 'llama-server -m ~/models/Qwen3.8-Flash-Next-IQ3_XXS-00001-of-00002.gguf -ngl 48 -dev CUDA0,CUDA1,Vulkan3 -ts 1,1,1 -c 65536 -fa on',
  },
  { kind: 'out', text: 'load_tensors: loading model tensors, this can take a while... (mmap = true)' },
  {
    kind: 'err',
    text: 'ggml_backend_cuda_buffer_type_alloc_buffer: allocating 15228.31 MiB on device 1: cudaMalloc failed: out of memory',
  },
  { kind: 'err', text: 'llama_model_load: error loading model: unable to allocate CUDA1 buffer' },
  {
    kind: 'cmd',
    text: 'llama-server -m ~/models/Qwen3.8-Flash-Next-IQ3_XXS-00001-of-00002.gguf -ngl 40 -ts 5,6,6 -c 32768 …',
  },
];

function Terminal() {
  return (
    <div
      className="overflow-hidden rounded-xl bg-[oklch(0.16_0.006_255)] text-[oklch(0.86_0.01_255)] shadow-surface ring-1 ring-white/10"
      aria-hidden="true"
    >
      <div className="flex h-9 items-end gap-1 border-b border-white/10 px-2 text-xs">
        {['llama-server', 'watch nvidia-smi', 'amd-smi monitor'].map((tab, i) => (
          <span
            key={tab}
            className={cn(
              'px-3 py-1.5 whitespace-nowrap',
              i === 0 ? 'rounded-t-md bg-white/8 text-white' : 'text-white/45',
              i === 2 && 'max-sm:hidden',
            )}
          >
            {tab}
          </span>
        ))}
      </div>
      <div className="flex flex-col gap-1.5 p-4 font-mono text-xs leading-relaxed wrap-anywhere sm:p-5 sm:text-[0.8125rem]">
        {SESSION.map((l) => (
          <p
            key={l.text}
            className={l.kind === 'err' ? 'text-[oklch(0.72_0.17_15)]' : l.kind === 'out' ? 'text-white/55' : ''}
          >
            {l.kind === 'cmd' && <span className="text-[oklch(0.78_0.12_185)]">$ </span>}
            {l.text}
          </p>
        ))}
        <p>
          <span className="text-[oklch(0.78_0.12_185)]">$ </span>
          <span className="inline-block h-3.5 w-2 translate-y-0.5 bg-white/70" />
        </p>
      </div>
    </div>
  );
}

export function WhySection() {
  return (
    <section aria-labelledby="why-title" className="mx-auto max-w-6xl px-6 py-24 sm:py-32">
      <div className="grid items-center gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:gap-16">
        <div>
          <h2
            id="why-title"
            className="max-w-[20ch] text-4xl font-semibold tracking-[-0.03em] text-balance sm:text-5xl"
          >
            One tab instead of a pile of terminals.
          </h2>
          <p className="mt-5 max-w-[56ch] text-lg text-muted-foreground text-pretty">
            llama-server is fast and flexible, but running it day to day means juggling long command lines, nvidia-smi
            in another terminal, and a lot of trial and error to fit a big model across several GPUs.
          </p>
        </div>
        <Terminal />
      </div>
      <dl className="mt-16 grid gap-8 sm:grid-cols-3 sm:gap-10">
        {PILLARS.map(([title, text]) => (
          <div key={title} className="border-t border-border pt-5">
            <dt className="font-semibold tracking-tight">{title}</dt>
            <dd className="mt-2 text-sm leading-relaxed text-muted-foreground text-pretty">{text}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
