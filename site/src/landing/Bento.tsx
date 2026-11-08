import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Tone } from './dashboard/tones';

export const SURFACE = 'rounded-2xl bg-card ring-1 ring-surface-border shadow-surface inset-shadow-highlight';

const TONE_TEXT: Record<Tone, string> = {
  blue: 'text-tone-blue',
  teal: 'text-tone-teal',
  amber: 'text-tone-amber',
  rose: 'text-tone-rose',
};

export interface AppPage {
  label: string;
  icon: LucideIcon;
}

/**
 * A feature section: the app pages it covers (named and drawn as in the app's sidebar, in the section's tone), a
 * headline, a lede, then a 6-column grid of cards.
 */
export function FeatureSection({
  id,
  tone,
  pages,
  title,
  lede,
  children,
}: {
  id: string;
  tone: Tone;
  pages: AppPage[];
  title: string;
  lede: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="mx-auto max-w-6xl scroll-mt-20 px-6 py-24 sm:py-32">
      <ul className="flex flex-wrap gap-x-5 gap-y-2 text-sm font-medium text-muted-foreground">
        {pages.map(({ label, icon: Icon }) => (
          <li key={label} className="flex items-center gap-2">
            <Icon className={cn('size-4', TONE_TEXT[tone])} aria-hidden="true" />
            {label}
          </li>
        ))}
      </ul>
      <h2
        id={`${id}-title`}
        className="mt-5 max-w-[22ch] text-4xl font-semibold tracking-[-0.03em] text-balance sm:text-5xl"
      >
        {title}
      </h2>
      <p className="mt-5 max-w-[60ch] text-lg text-muted-foreground text-pretty">{lede}</p>
      <div className="mt-14 grid grid-cols-1 gap-4 lg:grid-cols-6">{children}</div>
    </section>
  );
}

/**
 * A card of a feature grid: a title and one or two sentences (plus optional details), then its visual (a capture or
 * a replica). `side` puts the visual on the right from the lg breakpoint, for full-width cards.
 */
export function BentoCard({
  title,
  children,
  details,
  visual,
  side = false,
  className,
}: {
  title: string;
  children: React.ReactNode;
  details?: React.ReactNode;
  visual: React.ReactNode;
  side?: boolean;
  className?: string;
}) {
  return (
    <article
      className={cn(
        SURFACE,
        'flex min-w-0 flex-col overflow-hidden',
        side && 'lg:grid lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]',
        className,
      )}
    >
      <div className={cn('px-6 pt-6 pb-5', side && 'lg:pb-6')}>
        <h3 className="font-semibold tracking-tight">{title}</h3>
        <p className="mt-1.5 max-w-[56ch] text-sm leading-relaxed text-muted-foreground text-pretty">{children}</p>
        {details}
      </div>
      <div className={cn('relative flex min-h-0 flex-1 flex-col', side && 'lg:pt-6')}>{visual}</div>
    </article>
  );
}

/** Frame for a capture inside a card: inset from the top-left, flush with the right and bottom edges. */
export const SHOT_FRAME = 'ml-6 rounded-tl-xl ring-1 ring-surface-border';
