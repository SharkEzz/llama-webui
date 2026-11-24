import { type ReactNode, useState } from 'react';
import { cn } from '@/lib/utils';

/** The rows a list shows (the buffers hold more). */
export const SHOWN = 200;

/** A value as JSON, rendered only once opened (a snapshot is large, the list is rendered four times a second). */
export function JsonDetails({ summary, value }: { summary: ReactNode; value: () => unknown }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="group" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="cursor-pointer list-none rounded px-1.5 py-1 hover:bg-accent [&::-webkit-details-marker]:hidden">
        {summary}
      </summary>
      {open && (
        <pre className="mx-1.5 mb-1.5 max-h-72 overflow-auto rounded bg-muted/50 p-2 font-mono text-[0.7rem] leading-snug">
          {stringify(value())}
        </pre>
      )}
    </details>
  );
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    // `undefined` (a call that answered nothing) has no JSON.
    return value === undefined ? 'undefined' : JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Label and value pairs, two columns. */
export function Facts({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
      {items.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="truncate num">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Section({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** A small table: its head, then its rows. */
export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <table className="w-full text-left text-xs">
      <thead className="text-muted-foreground">
        <tr>
          {head.map((h) => (
            <th key={h} className="px-1.5 py-1 font-medium">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="num">{children}</tbody>
    </table>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-xs text-muted-foreground">{children}</p>;
}

/** A filter chip: pressed or not. */
export function Chip({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        'rounded-full border px-2 py-0.5 text-[0.7rem] transition-colors',
        pressed
          ? 'border-primary bg-primary/15 text-foreground'
          : 'border-border text-muted-foreground hover:bg-accent',
      )}
    >
      {children}
    </button>
  );
}
