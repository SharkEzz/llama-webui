import type { LucideIcon } from 'lucide-react';
import type { CSSProperties } from 'react';
import { Link } from 'react-router';
import { cn } from '@/lib/utils';
import { TONE_VAR, type Tone } from './dashboard/tones';
import { GlassCard } from './GlassCard';

export const TONE_TEXT: Record<Tone, string> = {
  blue: 'text-tone-blue',
  teal: 'text-tone-teal',
  amber: 'text-tone-amber',
  rose: 'text-tone-rose',
};

export interface AppPage {
  label: string;
  icon: LucideIcon;
  /** Its page in the user documentation ("/docs/dashboard/"). */
  doc: string;
}

/** Soft radial halo placed behind a feature chapter, tinted with the section's tone. */
export function SectionHalo({ tone }: { tone: Tone }) {
  const style: CSSProperties & { '--halo': string } = { '--halo': TONE_VAR[tone] };
  return (
    <div
      className="section-halo absolute top-10 left-1/2 -z-10 h-80 w-[min(58rem,90vw)] -translate-x-1/2 rounded-full"
      style={style}
      aria-hidden="true"
    />
  );
}

/** Frosted pill links naming the app pages covered by a feature section. */
export function PageChips({ pages, tone, className }: { pages: AppPage[]; tone: Tone; className?: string }) {
  return (
    <ul className={cn('flex flex-wrap gap-2', className)}>
      {pages.map(({ label, icon: Icon, doc }) => (
        <li key={label}>
          <Link
            to={doc}
            className="inline-flex items-center gap-2 rounded-full border border-border bg-card/75 px-3 py-1 text-xs font-medium text-foreground/90 backdrop-blur-md transition-colors hover:border-surface-border-bright hover:bg-surface-strong"
          >
            <Icon className={cn('size-3.5', TONE_TEXT[tone])} aria-hidden="true" />
            {label}
            <span className="sr-only"> documentation</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * A feature section: chapter halo, app page pills, headline, lede, and a custom layout for its cards.
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
    <section id={id} aria-labelledby={`${id}-title`} className="relative isolate mx-auto max-w-6xl px-6 py-24 sm:py-28">
      <SectionHalo tone={tone} />
      <PageChips pages={pages} tone={tone} />
      <h2
        id={`${id}-title`}
        className="mt-5 max-w-[22ch] text-4xl font-semibold tracking-[-0.035em] text-balance sm:text-5xl"
      >
        {title}
      </h2>
      <p className="mt-4 max-w-[60ch] text-lg text-pretty text-muted-foreground">{lede}</p>
      <div className="mt-12">{children}</div>
    </section>
  );
}

/**
 * A frosted glass card of a feature section: title, description (plus optional details), and its visual (capture or
 * replica). `side` places the visual on the right from the lg breakpoint for wide cards.
 */
export function BentoCard({
  title,
  tone,
  children,
  details,
  visual,
  side = false,
  className,
}: {
  title: string;
  tone?: Tone | undefined;
  children: React.ReactNode;
  details?: React.ReactNode;
  visual: React.ReactNode;
  side?: boolean;
  className?: string;
}) {
  return (
    <GlassCard
      tone={tone}
      className={cn('flex min-w-0 flex-col', side && 'lg:grid lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]', className)}
    >
      <div className={cn('px-6 pt-6 pb-5', side && 'lg:pb-6')}>
        <h3 className="text-[1.0625rem] font-semibold tracking-tight">{title}</h3>
        <p className="mt-1.5 max-w-[56ch] text-sm leading-relaxed text-pretty text-muted-foreground">{children}</p>
        {details}
      </div>
      <div className={cn('relative flex min-h-0 flex-1 flex-col', side && 'lg:pt-6')}>{visual}</div>
    </GlassCard>
  );
}

/** Frame for a capture inside a card: inset from the top-left, flush with the right and bottom edges. */
export const SHOT_FRAME = 'ml-6 rounded-tl-xl ring-1 ring-surface-border-bright/80';
