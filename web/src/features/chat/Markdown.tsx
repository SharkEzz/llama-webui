import { memo, type ReactElement, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { CodeBlock } from './CodeBlock';

const components: Components = {
  pre: ({ children }) => {
    const el = children as ReactElement<{ className?: string; children?: ReactNode }>;
    const lang = /language-(\S+)/.exec(el?.props?.className ?? '')?.[1];
    return <CodeBlock code={String(el?.props?.children ?? '').replace(/\n$/, '')} lang={lang} />;
  },
  code: ({ children }) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{children}</code>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-primary-ink underline underline-offset-4">
      {children}
    </a>
  ),
  p: ({ children }) => <p className="my-3 leading-7 first:mt-0 last:mb-0">{children}</p>,
  h1: ({ children }) => <h1 className="mt-5 mb-3 text-xl font-semibold">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-5 mb-3 text-lg font-semibold">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-4 mb-2 font-semibold">{children}</h3>,
  ul: ({ children }) => <ul className="my-3 list-disc space-y-1 pl-6">{children}</ul>,
  ol: ({ children }) => <ol className="my-3 list-decimal space-y-1 pl-6">{children}</ol>,
  blockquote: ({ children }) => (
    <blockquote className="my-3 border-l-2 border-border pl-4 text-muted-foreground">{children}</blockquote>
  ),
  hr: () => <hr className="my-4 border-border" />,
  table: ({ children }) => <Table className="my-3">{children}</Table>,
  thead: ({ children }) => <TableHeader>{children}</TableHeader>,
  tbody: ({ children }) => <TableBody>{children}</TableBody>,
  tr: ({ children }) => <TableRow>{children}</TableRow>,
  th: ({ children }) => <TableHead>{children}</TableHead>,
  td: ({ children }) => <TableCell>{children}</TableCell>,
};

/** Markdown d'une réponse : GFM (tableaux, listes de tâches), sans HTML brut (affiché comme texte). */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {text}
    </ReactMarkdown>
  );
});
