import { X } from 'lucide-react';
import { GLASS } from '@/components/glass/glass';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { type BlockTone, KIND_LABEL, toneVar } from './blocks';
import type { NodeDetail } from './flows';

interface DetailProps {
  detail: NodeDetail;
  tone: BlockTone;
  onClose: () => void;
}

/**
 * Every figure of the selected block. Its values change with each sample: nothing is announced (`aria-live="off"`),
 * a screen reader reads the panel when asked.
 */
export function Detail({ detail, tone, onClose }: DetailProps) {
  const { node, live } = detail;
  const kind = KIND_LABEL[node.kind];
  return (
    <section
      aria-label={`Details of ${node.label}`}
      aria-live="off"
      className={cn(GLASS, 'rounded-md px-3.5 py-3 text-sm')}
    >
      <div className="flex items-start gap-2">
        <span aria-hidden="true" className="mt-1.5 size-2 shrink-0 rounded-xs" style={{ background: toneVar(tone) }} />
        <div className="min-w-0 flex-1">
          <h2 className="text-[0.9375rem] font-semibold tracking-tight wrap-break-word">{node.label}</h2>
          {node.label !== kind && <p className="text-xs text-muted-foreground">{kind}</p>}
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          className="-mt-0.5 -mr-1.5 text-muted-foreground"
          aria-label="Close the details"
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </Button>
      </div>
      {live.facts.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">Nothing is measured for this block.</p>
      ) : (
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          {live.facts.map((fact) => (
            <div key={fact.label} className="contents">
              <dt className="text-muted-foreground">{fact.label}</dt>
              <dd className="text-right num">{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
