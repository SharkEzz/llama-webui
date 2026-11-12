import { ArrowDownUp } from 'lucide-react';
import { cn } from '@/lib/utils';

const BOX = 'rounded-xl bg-card px-4 py-3 ring-1 ring-border';

interface Node {
  name: string;
  detail: string;
}

const MODULES: Node[] = [
  { name: 'Supervisor', detail: 'starts, stops and watches llama-server' },
  { name: 'Monitor', detail: 'samples llama-server and the collectors every interval' },
  { name: 'Chat runs', detail: 'server-owned generations, streamed over SSE' },
  { name: 'Bench and sweeps', detail: 'llama-bench and temporary llama-server runs, one at a time' },
  { name: 'Tuning', detail: 'memory estimate and flag recommendation' },
  { name: 'Downloads', detail: 'Hugging Face queue, resume, sha256' },
  { name: 'Logs', detail: 'ring buffer: llama-server output, [llama-webui] and [bench] lines' },
  { name: 'Placement', detail: 'model split per device, read from the logs' },
];

const MACHINE: Node[] = [
  {
    name: 'llama-server',
    detail: 'child process (setpriv --pdeathsig); /health, /metrics, /slots, /props, /v1/chat/completions, /completion',
  },
  { name: 'llama-bench', detail: 'benchmark runs, sweep exploration, --list-devices' },
  { name: 'GPUs and kernel', detail: 'NVML (worker) or nvidia-smi, amdgpu sysfs, /proc, perf' },
  { name: 'Models folder', detail: 'GGUF files, headers read for metadata and estimates' },
  { name: 'Hugging Face', detail: 'search and downloads, only when you use them' },
];

function Link({ labels }: { labels: string[] }) {
  return (
    <div className="flex items-center gap-3 py-1 pl-5 text-xs text-muted-foreground">
      <ArrowDownUp className="size-4 shrink-0" aria-hidden="true" />
      <ul className="flex flex-wrap gap-x-4 gap-y-1 font-mono">
        {labels.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </div>
  );
}

function Tier({ title, children, accent }: { title: string; children: React.ReactNode; accent?: boolean }) {
  return (
    <div className={cn('rounded-2xl p-3 ring-1 ring-border sm:p-4', accent && 'bg-primary/4 ring-primary-ink/30')}>
      <p className="mb-3 px-1 text-xs font-medium text-muted-foreground">{title}</p>
      {children}
    </div>
  );
}

function Boxes({ nodes, className }: { nodes: Node[]; className: string }) {
  return (
    <ul className={cn('grid gap-2', className)}>
      {nodes.map((m) => (
        <li key={m.name} className={BOX}>
          <p className="font-medium">{m.name}</p>
          <p className="mt-0.5 text-xs [overflow-wrap:anywhere] text-muted-foreground">{m.detail}</p>
        </li>
      ))}
    </ul>
  );
}

/**
 * How llama-webui fits together, top to bottom: the browser, the single Bun process and its modules, and what they
 * talk to on the machine. Container queries lay the boxes out for the width of the docs column.
 */
export function ArchitectureDiagram() {
  return (
    <figure className="not-prose @container my-8 rounded-2xl bg-well p-3 text-sm inset-shadow-well ring-1 ring-border sm:p-4">
      <Tier title="Browser">
        <div className={BOX}>
          <p className="font-medium">React app</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            One page per feature, zustand stores fed by REST calls and the WebSocket.
          </p>
        </div>
      </Tier>

      <Link labels={['UI bundle', 'REST /api/*', 'WebSocket /ws', 'SSE chat streams']} />

      <Tier title="llama-webui: one Bun process, port 7860" accent>
        <div className={cn(BOX, 'mb-2')}>
          <p className="font-medium">Bun.serve</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            UI (HTML import in dev, Bun.build at startup in production), API routes wrapped in guarded(), WebSocket hub.
          </p>
        </div>
        <Boxes nodes={MODULES} className="grid-cols-1 @md:grid-cols-2 @3xl:grid-cols-4" />
        <div className={cn(BOX, 'mt-2')}>
          <p className="font-medium">SQLite (node:sqlite)</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Settings, profiles, conversations, benchmark runs, sweeps, downloads, model cache, in the data directory.
          </p>
        </div>
      </Tier>

      <Link labels={['spawn and signals', 'HTTP to llama-server', 'files and sysfs', 'HTTPS']} />

      <Tier title="The machine">
        <Boxes nodes={MACHINE} className="grid-cols-1 @md:grid-cols-2 @3xl:grid-cols-3" />
      </Tier>

      <figcaption className="mt-4 px-1 text-xs text-muted-foreground">
        The supervisor, the monitor, the logs and the bench gate live on globalThis, so they survive{' '}
        <code className="font-mono whitespace-nowrap">bun --hot</code> reloads.
      </figcaption>
    </figure>
  );
}
