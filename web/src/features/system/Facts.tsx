import type { ReactNode } from 'react';

/** Liste de faits libellé / valeur, valeurs en mono à droite. */
export function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="divide-y divide-border text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-baseline justify-between gap-4 py-1.5">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="num text-right">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
