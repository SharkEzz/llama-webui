import { Check, Copy } from 'lucide-react';
import { useRef, useState } from 'react';
import { cn } from '@/lib/utils';

type PreProps = React.ComponentProps<'pre'> & { 'data-title'?: string; 'data-language'?: string };

/** Code fence highlighted by Shiki at build time: optional title (```bash title="…"), copy button. */
export function CodeBlock({ children, className, 'data-title': title, 'data-language': lang, ...props }: PreProps) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(ref.current?.textContent ?? '');
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <figure className="not-prose group relative my-6 overflow-hidden rounded-xl bg-well inset-shadow-well ring-1 ring-border">
      {title && (
        <figcaption className="border-b border-border px-4 py-2 font-mono text-xs text-muted-foreground">
          {title}
        </figcaption>
      )}
      <pre
        ref={ref}
        data-language={lang}
        className={cn(className, 'overflow-x-auto px-4 py-3.5 font-mono text-[0.8125rem] leading-6')}
        {...props}
      >
        {children}
      </pre>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? 'Copied' : 'Copy code'}
        className={cn(
          'absolute right-2 flex size-8 items-center justify-center rounded-md text-muted-foreground transition',
          'hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:ring-3 focus-visible:ring-ring/50',
          'bg-well opacity-0 backdrop-blur group-hover:opacity-100 max-md:opacity-100',
          title ? 'top-11' : 'top-2',
        )}
      >
        {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
      </button>
    </figure>
  );
}
