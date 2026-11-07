import type { Snapshot } from '@llama-webui/shared';
import { Link } from 'react-router';
import { Gauge } from '@/components/glass/Gauge';
import { GLASS } from '@/components/glass/glass';
import type { Tone } from '@/components/glass/tones';
import { Card } from '@/components/ui/card';
import { formatBps, formatBytes } from '@/lib/format';
import { cn } from '@/lib/utils';

const TONES: Tone[] = ['blue', 'teal', 'amber', 'rose'];
const short = (name: string) => name.replace(/^NVIDIA GeForce /, '').replace(/^Radeon /, '');

/** Bandeau système compact : CPU, RAM, VRAM des GPU du serveur (toutes les GPU lues sans serveur), disque du modèle. */
export function SystemStrip({ snapshot }: { snapshot: Snapshot | null }) {
  const sys = snapshot?.system;
  const mem = sys?.mem;
  const memUsed = mem ? mem.totalBytes - mem.availableBytes : 0;
  const gpus = snapshot
    ? snapshot.gpus.length > 0
      ? snapshot.gpus
      : snapshot.allGpus.filter((g) => !g.hidden && !g.suspended)
    : [];
  const disk = snapshot?.disk;

  return (
    <Card size="sm" className={cn(GLASS, 'flex-row flex-wrap items-start justify-around gap-x-6 gap-y-4 px-4 py-4')}>
      <Link to="/system" className="contents" aria-label="Voir la page Système">
        <Gauge label="CPU" value={round(sys?.cpuPct)} size={84} tone="blue" />
        <Gauge
          label={mem ? `RAM ${formatBytes(memUsed, 0)} / ${formatBytes(mem.totalBytes, 0)}` : 'RAM'}
          value={mem && mem.totalBytes > 0 ? round((100 * memUsed) / mem.totalBytes) : 0}
          size={84}
          tone="teal"
        />
        {gpus.map((g, i) => (
          <Gauge
            key={g.key}
            label={`VRAM ${short(g.name)}`}
            value={g.vramTotalBytes > 0 ? round((100 * g.vramUsedBytes) / g.vramTotalBytes) : 0}
            size={84}
            tone={TONES[(i + 2) % TONES.length]!}
          />
        ))}
      </Link>
      <div className="flex min-w-36 flex-col gap-1 self-center text-sm">
        <span className="text-xs text-muted-foreground">
          Disque{disk?.model ? ` du modèle (${disk.model.disk})` : ''}
        </span>
        <span className="num">{disk ? formatBps(disk.model?.readBps ?? disk.readBps) : '—'}</span>
        <span className="text-xs text-muted-foreground">en lecture</span>
      </div>
    </Card>
  );
}

const round = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? 0 : Math.round(v));
