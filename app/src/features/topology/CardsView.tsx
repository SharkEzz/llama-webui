import type { TopologyNode } from '@llama-webui/shared';
import { useMemo } from 'react';
import { Block, factOf, FillPct, KIND_LABEL, Layers, LoadBar, Row, Threads, toneOfNode } from './blocks';
import type { NodeLive } from './flows';
import { layoutCards, TALL_THREADS } from './layoutCards';
import { Stage, type ViewProps } from './Stage';

/** The machine as a diagram of glass cards: the CPU on top, what hangs off it below, linked by curves. */
export function CardsView({ graph, live, peers, tones, ...stage }: ViewProps) {
  const layout = useMemo(() => layoutCards(graph, peers), [graph, peers]);
  return (
    <Stage graph={graph} layout={layout} tones={tones} {...stage}>
      {graph.nodes.map((node) => {
        const rect = layout.rects.get(node.id);
        const l = live.get(node.id);
        if (!rect || !l) return null;
        return (
          <Block
            key={node.id}
            node={node}
            live={l}
            rect={rect}
            tone={toneOfNode(node, tones)}
            className="flex flex-col gap-[7px] px-[13px] py-[11px]"
          >
            <Head node={node} />
            <Body node={node} live={l} compact={rect.h < 150} />
          </Block>
        );
      })}
    </Stage>
  );
}

function Head({ node }: { node: TopologyNode }) {
  const kind = KIND_LABEL[node.kind];
  return (
    <span className="flex items-center gap-[7px] text-[13px]">
      {node.kind !== 'nvme' && node.kind !== 'chipset' && (
        <span aria-hidden="true" className="size-2 shrink-0 rounded-xs bg-(--tone)" />
      )}
      <b className="truncate font-semibold tracking-tight">{node.label}</b>
      {node.label !== kind && <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{kind}</span>}
    </span>
  );
}

const BIG = 'num text-[25px] leading-none font-semibold tracking-tight';

/** `compact`: a GPU inside the CPU has a small card, with rows instead of the large figure. */
function Body({ node, live, compact }: { node: TopologyNode; live: NodeLive; compact: boolean }) {
  if (live.dim) return <span className="text-xs text-muted-foreground">{factOf(live, 'State') ?? live.headline}</span>;
  if (node.kind === 'gpu')
    return compact ? (
      <>
        <Row label="Utilization" value={live.headline} />
        <Row label="VRAM" value={live.sub} />
        <Layers live={live} neutral className="h-2.5 rounded-full" />
      </>
    ) : (
      <>
        <span className="flex items-end gap-[7px]">
          <span className={BIG}>{live.headline}</span>
          <span className="text-xs leading-none text-muted-foreground">utilization</span>
          <span className="ml-auto flex flex-col items-end num text-[11px] leading-[13px] text-foreground">
            <span>{factOf(live, 'Temperature') ?? '—'}</span>
            <span>{factOf(live, 'Power') ?? '—'}</span>
          </span>
        </span>
        <LoadBar pct={live.barPct} />
        <Row label="VRAM" value={<FillPct live={live} />} />
        <Layers live={live} neutral className="h-2.5 rounded-full" />
        <span className="mt-auto truncate num text-xs text-foreground">{live.sub ?? '—'}</span>
      </>
    );
  if (node.kind === 'cpu') {
    const threads = live.cores.length || Number(node.detail.logicalThreads) || 0;
    const rows = threads > 64 ? 4 : threads > TALL_THREADS ? 2 : 1;
    return (
      <>
        <span className="flex items-baseline gap-[7px]">
          <span className={BIG}>{live.headline}</span>
          <span className="text-xs text-muted-foreground">load</span>
        </span>
        {threads > 0 && (
          <Threads
            cores={live.cores}
            count={threads}
            columns={Math.ceil(threads / rows)}
            className={rows > 1 ? 'h-[47px]' : 'h-[22px]'}
          />
        )}
        <span className="mt-auto flex justify-between gap-2.5 text-xs text-muted-foreground">
          <span>
            Temperature <span className="num text-foreground">{factOf(live, 'Temperature') ?? '—'}</span>
          </span>
          <span>
            Frequency <span className="num text-foreground">{factOf(live, 'Frequency') ?? '—'}</span>
          </span>
        </span>
      </>
    );
  }
  if (node.kind === 'ram')
    return (
      <>
        <span className="flex items-baseline gap-[7px]">
          <span className={BIG}>{live.fillPct === null ? '—' : <FillPct live={live} />}</span>
          <span className="text-xs text-muted-foreground">in use</span>
        </span>
        <Layers live={live} className="h-2.5 rounded-full" />
        <span className="mt-auto num text-xs text-foreground">{live.headline}</span>
      </>
    );
  if (node.kind === 'nvme')
    return (
      <>
        <Row label="Read" value={factOf(live, 'Read')} />
        <Row label="Write" value={factOf(live, 'Write')} />
      </>
    );
  return (
    <>
      <Row label="Devices" value={factOf(live, 'Devices')} />
      <Row label="CPU link" value={live.headline} />
    </>
  );
}
