import { type ComponentProps, type ReactNode, useRef } from 'react';
import { cn } from '@/lib/utils';

// Box shared by the textarea and its highlighted layer: same border, padding, font and line wrapping.
const BOX = 'rounded-lg border px-2.5 py-2 font-mono text-xs leading-5 whitespace-pre-wrap break-words';

interface CodeTextareaProps extends Omit<ComponentProps<'textarea'>, 'value' | 'onChange'> {
  value: string;
  onChange(value: string, el: HTMLTextAreaElement): void;
  /** Highlighted rendering of the text (same characters, in the same order). */
  highlight(text: string): ReactNode;
}

/**
 * Syntax-highlighted textarea: the real text is transparent, an identical highlighted <pre> is drawn underneath.
 * Editing stays native (caret, selection, clipboard, undo).
 */
export function CodeTextarea({ value, onChange, highlight, className, ref, onScroll, ...props }: CodeTextareaProps) {
  const pre = useRef<HTMLPreElement>(null);
  return (
    <div className={cn('relative', className)}>
      <pre
        ref={pre}
        aria-hidden="true"
        className={cn(
          BOX,
          'pointer-events-none absolute inset-0 m-0 overflow-hidden border-transparent bg-well inset-shadow-well text-foreground',
        )}
      >
        {highlight(value)}
        {/* a trailing empty line must take up its height too */}
        {'\n'}
      </pre>
      <textarea
        ref={ref}
        value={value}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value, e.target)}
        onScroll={(e) => {
          if (pre.current) pre.current.scrollTop = e.currentTarget.scrollTop;
          onScroll?.(e);
        }}
        className={cn(
          BOX,
          'relative block field-sizing-content min-h-16 w-full resize-y border-input bg-transparent text-transparent caret-foreground outline-none transition-colors',
          'selection:bg-primary/30 selection:text-transparent placeholder:text-muted-foreground',
          'focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
          'aria-invalid:border-destructive/50 aria-invalid:ring-3 aria-invalid:ring-destructive/20',
        )}
        {...props}
      />
    </div>
  );
}
