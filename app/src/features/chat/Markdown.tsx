import { Fragment, memo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { type Blocks, nextBlocks, parsedStarts, pieces, recent, topBlocks } from './blocks';
import { components } from './mdComponents';

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
