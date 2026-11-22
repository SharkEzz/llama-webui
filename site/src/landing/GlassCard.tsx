import type { CSSProperties, PointerEvent } from 'react';
import { cn } from '@/lib/utils';
import { TONE_VAR, type Tone } from './dashboard/tones';

interface GlassCardProps {
  tone?: Tone | undefined;
  reveal?: boolean | undefined;
  as?: 'article' | 'div' | undefined;
  className?: string | undefined;
  children: React.ReactNode;
}

/**
 * Obsidian Aurora frosted glass card: backdrop blur, specular top highlight, scroll-driven reveal, and
 * cursor-tracking spotlight + border glow on hover-capable pointers.
 */
export function GlassCard({ tone, reveal = true, as = 'article', className, children }: GlassCardProps) {
  const Tag = as;
  const style: (CSSProperties & { '--card-tone': string }) | undefined = tone
    ? { '--card-tone': TONE_VAR[tone] }
    : undefined;

  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    if (e.pointerType !== 'mouse') return;
    const rect = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty('--mx', `${e.clientX - rect.left}px`);
    e.currentTarget.style.setProperty('--my', `${e.clientY - rect.top}px`);
  };

  return (
    <Tag
      onPointerMove={onPointerMove}
      style={style}
      className={cn('glass spotlight-card overflow-hidden', reveal && 'scroll-reveal', className)}
    >
      {children}
    </Tag>
  );
}
