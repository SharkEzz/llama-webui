import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { copyText } from '@/lib/clipboard';
import { highlight } from '@/lib/highlight';

/** Code block: language, Copy button, shiki highlighting (plain text until it is ready). */
export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    // While streaming, the code changes every frame: wait for it to settle a moment.
    const t = setTimeout(() => {
      highlight(code, lang).then(
        (h) => live && setHtml(h),
        () => live && setHtml(null),
      );
    }, 120);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [code, lang]);

  return (
    <div className="my-3 overflow-hidden rounded-md bg-well inset-shadow-well ring-1 ring-border">
      <div className="flex items-center justify-between border-b border-border px-3 py-1">
        <span className="font-mono text-xs text-muted-foreground">{lang || 'text'}</span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Copy code"
          onClick={() =>
            copyText(code).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
          }
        >
          {copied ? <Check /> : <Copy />}
        </Button>
      </div>
      {html ? (
        // HTML produced by shiki from the text (escaped by shiki), not HTML from the reply.
        <div
          className="overflow-x-auto px-3 py-2 font-mono text-[0.8rem] leading-6"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: HTML produced by shiki from the text (escaped), not the reply's HTML
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="overflow-x-auto px-3 py-2 font-mono text-[0.8rem] leading-6">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}
