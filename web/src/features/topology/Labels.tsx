import type { TopologyGraph } from '@llama-webui/shared';
import type { RefObject } from 'react';
import { TONE_VAR, type Tone } from '@/components/glass/tones';
import { cn } from '@/lib/utils';
import { type Level, type LinkBadge, type LinkFlow, linkBadge, type NodeLive, type PeerLink } from './flows';

interface LabelsProps {
  graph: TopologyGraph;
  live: Map<string, NodeLive>;
  flows: Map<string, LinkFlow>;
  /** Peer-to-peer links between GPUs: each gets a tag at its middle. */
  peers: PeerLink[];
  tones: Map<string, Tone>;
  /** llama-server is loading, processing a prompt or generating: every link with traffic shows its badge. */
  busy: boolean;
  hovered: string | null;
  layerRef: RefObject<HTMLDivElement | null>;
}

const CHIP = 'whitespace-nowrap rounded-md bg-card/80 px-1.5 py-0.5 ring-1 ring-surface-border backdrop-blur-sm';

/** Alert of a link badge: its ring and the line that spells out the share of the capacity. */
const LEVEL_UI: Record<Level, { ring: string; text: string }> = {
  ok: { ring: '', text: 'text-muted-foreground' },
  warn: { ring: 'ring-warning/70', text: 'text-warning' },
  crit: { ring: 'ring-destructive/80', text: 'text-destructive' },
};

/**
 * Block labels and the hovered block's tooltip: plain DOM (theme typography and tokens), anchored by the scene to the
 * top of each block (see <Projector>). Invisible until the scene has placed them.
 *
 * The badge of a link is stacked on the label of the block at its downstream end, where the link arrives: a badge
 * floating on the link itself would cover its neighbors as soon as a few links fan out of the CPU, or the camera turns.
 */
export function Labels({ graph, live, flows, peers, tones, busy, hovered, layerRef }: LabelsProps) {
  return (
    <div ref={layerRef} className="pointer-events-none absolute inset-0 z-30 overflow-hidden">
      {peers.map((peer) => (
        <div key={peer.id} data-peer={peer.id} className="invisible absolute top-0 left-0 will-change-transform">
          <span
            className={cn(
              CHIP,
              'block -translate-x-1/2 -translate-y-1/2 text-[11px] font-medium leading-tight',
              peer.confirmed ? 'text-foreground' : 'text-muted-foreground',
            )}
          >
            {peer.confirmed ? 'P2P' : 'P2P requested'}
          </span>
        </div>
      ))}
      {graph.nodes.map((n) => {
        const l = live.get(n.id);
        if (!l) return null;
        const isHovered = hovered === n.id;
        const tone = tones.get(n.id);
        const uplink = graph.links.find((x) => x.to === n.id);
        const flow = uplink ? flows.get(uplink.id) : undefined;
        const badge = uplink && flow ? linkBadge(uplink, n, flow, busy) : null;
        return (
          <div
            key={n.id}
            data-node={n.id}
            className={cn('group invisible absolute top-0 left-0 will-change-transform', isHovered && 'z-10')}
          >
            <div className="relative flex -translate-x-1/2 -translate-y-full flex-col items-center gap-0.5">
              {isHovered && l.facts.length > 0 && (
                <dl className="absolute bottom-full left-1/2 mb-2 grid min-w-52 -translate-x-1/2 grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-lg bg-popover px-3 py-2 text-xs shadow-surface ring-1 ring-surface-border group-[.tip-below]:top-full group-[.tip-below]:bottom-auto group-[.tip-below]:mt-2 group-[.tip-below]:mb-0">
                  <dt className="col-span-2 mb-0.5 font-medium text-foreground">{n.label}</dt>
                  {l.facts.map((f) => (
                    <Row key={f.label} label={f.label} value={f.value} />
                  ))}
                </dl>
              )}
              {badge && <Badge badge={badge} />}
              <div
                className={cn(
                  CHIP,
                  'flex flex-col items-center text-center',
                  l.dim && 'opacity-60',
                  isHovered && 'ring-primary/60',
                )}
              >
                <span className="max-w-32 truncate text-[11px] font-medium leading-tight text-foreground">
                  {n.label}
                </span>
                {l.headline !== null && (
                  <span className="flex items-center gap-1.5">
                    <span className="num text-[11px] leading-tight text-muted-foreground">{l.headline}</span>
                    {l.barPct !== null && (
                      <span className="h-1 w-12 overflow-hidden rounded-full bg-well" aria-hidden="true">
                        <span
                          className="block h-full rounded-full transition-[width] duration-500"
                          style={{
                            width: `${Math.min(100, Math.max(0, l.barPct))}%`,
                            background: tone ? TONE_VAR[tone] : 'var(--primary)',
                          }}
                        />
                      </span>
                    )}
                  </span>
                )}
                {l.sub !== null && <span className="num text-[11px] leading-tight text-muted-foreground">{l.sub}</span>}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Traffic of a link: the exact figure of each direction, and the share of the capacity once it matters. */
function Badge({ badge }: { badge: LinkBadge }) {
  const ui = LEVEL_UI[badge.level];
  return (
    <div className={cn(CHIP, 'fade-in animate-in duration-300', ui.ring)}>
      <dl className="grid grid-cols-[auto_auto] gap-x-2 text-[11px] leading-tight">
        {badge.lines.map((line) => (
          <BadgeLine key={line.label} label={line.label} value={line.value} />
        ))}
      </dl>
      {badge.pct && (
        <p className={cn('num text-center text-[11px] font-medium leading-tight', ui.text)}>{badge.pct} of capacity</p>
      )}
    </div>
  );
}

function BadgeLine({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="num text-right text-foreground">{value}</dd>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="whitespace-nowrap text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          'num text-right text-foreground',
          value.length > 28 ? 'max-w-56 whitespace-normal' : 'whitespace-nowrap',
        )}
      >
        {value}
      </dd>
    </>
  );
}
