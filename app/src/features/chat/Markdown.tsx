import { Fragment, isValidElement, memo, type ReactNode, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { type Blocks, nextBlocks, pieces, type StartsOf, type TopBlock, topBlocks } from './blocks';
import { CodeBlock } from './CodeBlock';

export const components: Components = {
  pre: ({ children }) => {
    // The `code` element react-markdown puts in a `pre`, its text as one string
    const el = isValidElement<{ className?: string; children?: ReactNode }>(children) ? children : undefined;
    const lang = /language-(\S+)/.exec(el?.props.className ?? '')?.[1];
    const text = el?.props.children;
    return <CodeBlock code={(typeof text === 'string' ? text : '').replace(/\n$/, '')} lang={lang} />;
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

/** Texts parsed recently → their top-level blocks, as their parse found them. */
const recent = new Map<string, readonly TopBlock[]>();

/** The top-level blocks of a text parsed recently (by `Block`): where its next blocks can be cut. */
export const parsedStarts: StartsOf = (text) => recent.get(text);

/**
 * A remark plugin that changes nothing: it notes the top-level blocks of the parsed text, for the next text of a
 * streamed reply (`nextBlocks`). The same text always gives the same blocks, so this only caches its parse.
 */
function noteBlocks() {
  return (tree: Parameters<typeof topBlocks>[0], file: { value: unknown }) => {
    if (typeof file.value !== 'string') return;
    recent.delete(file.value);
    recent.set(file.value, topBlocks(tree, file.value));
    // A streamed reply reads back only the text it rendered last: a few entries are enough
    if (recent.size > 32) recent.delete(recent.keys().next().value!);
  };
}

const plugins = [remarkGfm, noteBlocks];

/** One piece of a reply: the whole of it when it is finished, a block of it while it streams. */
const Block = memo(function Block({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={plugins} components={components}>
      {text}
    </ReactMarkdown>
  );
});

/**
 * The pieces of a reply, each keyed by where it starts: a piece keeps its components (a code block its highlighting)
 * while the reply grows, and only the last one changes. The line break between two pieces is the one react-markdown
 * puts between two blocks.
 */
export function MarkdownBlocks({ blocks }: { blocks: Blocks }) {
  return pieces(blocks).map((text, i) => (
    <Fragment key={blocks.starts[i]}>
      {i > 0 && '\n'}
      <Block text={text} />
    </Fragment>
  ));
}

/**
 * Markdown of a reply: GFM (tables, task lists), no raw HTML (shown as text). A streamed reply is cut into blocks as it
 * grows (`blocks.ts`): the blocks before the last one are neither parsed nor rendered again.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const [blocks, setBlocks] = useState<Blocks>(() => ({ text, starts: [0], finished: [] }));
  let shown = blocks;
  if (blocks.text !== text) {
    shown = nextBlocks(blocks, text, parsedStarts);
    setBlocks(shown);
  }
  return <MarkdownBlocks blocks={shown} />;
});
