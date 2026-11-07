import { Flag } from 'lucide-react';
import { GlassCard } from '@/components/glass/GlassCard';
import { StatTile } from '@/components/glass/StatTile';
import { Badge } from '@/components/ui/badge';
import { formatDuration } from '@/lib/format';
import { useHealth } from '@/lib/health';
import { useNow } from '@/lib/useNow';
import { useWs, WS_STATUS_UI } from '@/lib/ws';

const MILESTONES = [
  {
    id: 'J2',
    title: 'Server, profiles, logs',
    detail: 'Start and stop llama-server, manage profiles, follow the logs.',
  },
  { id: 'J3', title: 'Monitoring', detail: 'Throughput, slots, NVIDIA and AMD GPUs, CPU, memory, disk in real time.' },
  { id: 'J4', title: 'Models and chat', detail: 'Browse GGUF files, chat with the loaded model.' },
  { id: 'J5', title: 'Benchmark', detail: 'Measure with llama-bench or the server, compare the history.' },
  { id: 'J6', title: 'Tuning and sweep', detail: 'Offload recommendations and automatic exploration of settings.' },
  { id: 'J7', title: 'Polish', detail: 'Shortcuts, empty states, error handling, documentation.' },
] as const;

export function HomePage() {
  const status = useWs((s) => s.status);
  const { health, fetchedAt, error } = useHealth();
  const now = useNow(1000);
  const online = status === 'open';

  const uptime = online && health && fetchedAt ? formatDuration(health.uptimeMs + (now - fetchedAt)) : '—';

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">llama-webui</h1>
        <p className="max-w-prose text-muted-foreground">
          Local supervisor for llama-server: profiles, monitoring, chat, benchmark and tuning on this machine.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile
          label="Real-time connection"
          value={WS_STATUS_UI[status].label}
          tone={online ? 'teal' : 'rose'}
          mono={false}
          hint={online ? 'WebSocket open' : 'Retrying automatically'}
        />
        <StatTile
          label="API version"
          value={health?.version ?? '—'}
          tone="blue"
          hint={error && !online ? error : undefined}
        />
        <StatTile label="Server uptime" value={uptime} tone="amber" />
      </div>

      <GlassCard title="Milestones" icon={Flag}>
        <ol className="flex flex-col divide-y divide-border">
          {MILESTONES.map((m) => (
            <li key={m.id} className="flex items-start gap-4 py-3 first:pt-0 last:pb-0">
              <span className="num w-7 shrink-0 pt-px text-sm text-muted-foreground">{m.id}</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{m.title}</p>
                <p className="text-sm text-muted-foreground">{m.detail}</p>
              </div>
              <Badge variant="outline" className="shrink-0 text-muted-foreground">
                upcoming
              </Badge>
            </li>
          ))}
        </ol>
      </GlassCard>
    </div>
  );
}
