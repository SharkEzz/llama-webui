/**
 * A streamed reply cut into Markdown blocks, so that a flush parses and renders only its end.
 *
 * `starts[i]` is where piece `i` of `text` begins (`starts[0]` is 0); the last piece runs to the end of the text. Each
 * piece is rendered on its own, and the pieces put together render as the whole text: a piece holds one or more
 * top-level blocks, cut only where the cut is final (`isFinal`). The cuts come from the parse of the last piece, which
 * rendering it makes anyway (`StartsOf`): finding them costs no parse of its own, and the pieces before the last one are
 * never parsed again.
 *
 * `finished` holds the text of each piece before the last one, copied once when it is cut (`detached`), and the last
 * piece is copied at each flush (`pieces`): what React, the parse and the DOM keep of a piece (its last two renders)
 * does not keep the reply as it was then.
 */
export interface Blocks {
  readonly text: string;
  readonly starts: readonly number[];
  readonly finished: readonly string[];
}

/** A top-level block of a parsed text. */
export interface TopBlock {
  /** Its offset in the text. */
  readonly start: number;
  /** Whether it ends open: in a code block or an HTML block left open in a list item or a quote (`topBlocks`). */
  readonly open: boolean;
}

/** The top-level blocks of a text, if it was parsed (rendered) recently. */
export type StartsOf = (text: string) => readonly TopBlock[] | undefined;

/** The parts of an mdast node read here. */
interface Node {
  readonly type: string;
  readonly position?: { readonly start: { readonly offset?: number }; readonly end: { readonly offset?: number } };
  readonly children?: readonly Node[];
}

const fence = /^(`{3,}|~{3,})/;

/** Whether a fenced code block (from its source) has its closing fence. */
function closedFence(source: string): boolean {
  const open = fence.exec(source)?.[1];
  if (!open) return true;
  const lines = source.split('\n');
  const last = lines.at(-1)!.trim();
  // The same character, at least as many times, and nothing else
  return lines.length > 1 && last.startsWith(open) && /^(`+|~+)$/.test(last);
}

/**
 * The top-level blocks of `tree`, the parse of `source`. A code or HTML block left open inside a list item or a quote
 * is closed by the line that ends the container, and takes the blank lines before that line as its own content; on its
 * own, it would take them up to the end of the text, one more: a cut is never made after such a block. The open block
 * is the last one down the chain of last children.
 */
export function topBlocks(tree: Node, source: string): TopBlock[] {
  return (tree.children ?? []).map((child) => {
    let last = child;
    while (last.children?.length) last = last.children.at(-1)!;
    const start = child.position?.start.offset ?? 0;
    const inside = last !== child;
    const open =
      inside &&
      (last.type === 'html' ||
        (last.type === 'code' &&
          !closedFence(source.slice(last.position?.start.offset ?? 0, last.position?.end.offset ?? source.length))));
    return { start, open };
  });
}

/**
 * Constructs that tie a block to text elsewhere in the reply, which a piece rendered on its own would not see: a link
 * reference definition (`[id]: url`, which a link anywhere uses), a footnote (`[^1]`, numbered and listed at the end
 * of the reply), a carriage return (a line ending the cuts do not look for). A reply with one is rendered whole.
 */
const GLOBAL = /\]:|\[\^|\r/;

const blankLine = /^[ \t]*$/;
/** A line of an indented code block, at the top level: 4 columns of indentation. */
const indented = /^( {0,3}\t| {4})/;

/** The line that ends with the line break at `end`. */
const lineEndingAt = (text: string, end: number) => text.slice(text.lastIndexOf('\n', end - 1) + 1, end);

/**
 * Whether the top-level block starting at `at` in `text` (as parsed) starts there in every text that extends `text`,
 * so that the blocks before it are final, and renders the same on its own. CommonMark decides line by line whether a
 * line continues the open blocks, from that line alone once the line before it is blank (no lazy continuation): a line
 * that starts a new top-level block after a blank line, unindented, stays one once it is complete. A list item that
 * would continue the list or a fence that would close a code block is part of the block before it in the parse, never
 * a start. The line must be complete: `2` after a list `1. a` is a paragraph, `2. b` continues the list.
 *
 * One exception, found by testing: after an indented code block, micromark reads the next block as if it interrupted a
 * paragraph (`2. x` is a paragraph there, an ordered list on its own), so no cut is made after one.
 */
function isFinal(text: string, at: number): boolean {
  if (at < 2 || text[at - 1] !== '\n') return false;
  const first = text[at];
  if (first === undefined || first === ' ' || first === '\t') return false;
  if (!text.includes('\n', at)) return false;
  let end = at - 1;
  if (!blankLine.test(lineEndingAt(text, end))) return false;
  // The last line that is not blank: not one of an indented code block
  while (end > 0) {
    const line = lineEndingAt(text, end);
    if (!blankLine.test(line)) return !indented.test(line);
    end = text.lastIndexOf('\n', end - 1);
  }
  return false;
}

/**
 * `text` as a string of its own. In V8 a slice of a long string is a view that keeps the whole string alive, and so is
 * every slice of the slice (the values of its parse, the text of its DOM, the props React keeps of its last two
 * renders): a finished piece would keep the whole reply as it was when the piece was last rendered, a copy per piece.
 * Slicing a concatenation makes V8 copy the concatenation first, and the result is a view of that copy only.
 */
export const detached = (text: string): string => ` ${text}`.slice(1);

/**
 * The blocks of `text`, the next text of the reply after `prev`. A text that extends the previous one keeps its cuts
 * and adds those its last piece's parse made final; any other text (another reply, a regenerated one) starts again
 * from one piece, cut at the next flush. A finished reply rendered at once stays one piece: it is parsed once anyway.
 */
export function nextBlocks(prev: Blocks, text: string, startsOf: StartsOf): Blocks {
  if (text === prev.text) return prev;
  if (!text.startsWith(prev.text) || GLOBAL.test(text)) return { text, starts: [0], finished: [] };
  const tail = prev.starts.at(-1) ?? 0;
  const found = startsOf(prev.text.slice(tail)) ?? [];
  const starts = [...prev.starts];
  const finished = [...prev.finished];
  // The first block of the last piece starts it (after its blank lines, if any): the cuts are before the others
  for (let i = 1; i < found.length; i++) {
    const at = tail + found[i]!.start;
    if (!found[i - 1]!.open && isFinal(prev.text, at)) {
      finished.push(detached(prev.text.slice(starts.at(-1), at)));
      starts.push(at);
    }
  }
  return { text, starts, finished };
}

/** The text of each piece, each a string of its own (`detached`): the last one is copied at each flush. */
export const pieces = ({ text, starts, finished }: Blocks): string[] => [
  ...finished,
  detached(text.slice(starts.at(-1))),
];
