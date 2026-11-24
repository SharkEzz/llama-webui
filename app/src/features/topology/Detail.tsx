import { Popover as PopoverPrimitive } from '@base-ui/react/popover';
import type { TopologyGraph } from '@llama-webui/shared';
import { X } from 'lucide-react';
import { useEffect } from 'react';
import type { Tone } from '@/components/glass/tones';
import { Button } from '@/components/ui/button';
import { PopoverContent, PopoverTitle } from '@/components/ui/popover';
import { KIND_LABEL, toneOfNode, toneVar } from './constants';
import { detailPopover } from './detailPopover';
import { detailOf, type NodeLive } from './flows';

interface DetailProps {
  graph: TopologyGraph | null;
  live: Map<string, NodeLive> | null;
  tones: Map<string, Tone>;
}

/** The details of the block that was selected, in a popover beside it. */
export function DetailPopover(props: DetailProps) {
  return (
    <PopoverPrimitive.Root handle={detailPopover}>
      {({ payload }) => <Details id={payload ?? null} {...props} />}
    </PopoverPrimitive.Root>
  );
}

/**
 * Every figure of a block. Its values change with each sample: nothing is announced (`aria-live="off"`), a screen
 * reader reads them when asked.
 */
function Details({ id, graph, live, tones }: DetailProps & { id: string | null }) {
  const detail = graph && live ? detailOf(graph, live, id) : null;
  // A block that left the graph has no details any more: the popover closes with it
  const gone = id !== null && detail === null;
  useEffect(() => {
    if (gone) detailPopover.close();
  }, [gone]);
  if (!detail) return null;

  const { node, live: figures } = detail;
  const kind = KIND_LABEL[node.kind];
  return (
    <PopoverContent
      side="right"
      align="start"
      sideOffset={10}
      className="max-h-(--available-height) w-76 gap-2 overflow-y-auto px-3.5 py-3"
    >
      <div className="flex items-start gap-2">
        <span
          aria-hidden="true"
          className="mt-1.5 size-2 shrink-0 rounded-xs"
          style={{ background: toneVar(toneOfNode(node, tones)) }}
        />
        <div className="min-w-0 flex-1">
          <PopoverTitle className="text-[0.9375rem] font-semibold tracking-tight wrap-break-word">
            {node.label}
          </PopoverTitle>
          {node.label !== kind && <p className="text-xs text-muted-foreground">{kind}</p>}
        </div>
        <PopoverPrimitive.Close
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              className="-mt-0.5 -mr-1.5 text-muted-foreground"
              aria-label="Close the details"
            />
          }
        >
          <X aria-hidden="true" />
        </PopoverPrimitive.Close>
      </div>
      {figures.facts.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nothing is measured for this block.</p>
      ) : (
        <dl aria-live="off" className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          {figures.facts.map((fact) => (
            <div key={fact.label} className="contents">
              <dt className="text-muted-foreground">{fact.label}</dt>
              <dd className="text-right num">{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </PopoverContent>
  );
}
