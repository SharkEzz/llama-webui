import { getHeapStatistics, setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { describe, expect, test } from 'vitest';
import { type Blocks, detached, nextBlocks, pieces, type StartsOf } from './blocks';
import { components, MarkdownBlocks, parsedStarts } from './Markdown';

/** The reply as one text: the rendering before it was cut into blocks. */
const whole = (text: string) =>
  renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm], components }, text));

/** The reply as it streams: each text extends the previous one, the blocks follow it. */
const byBlocks = (blocks: Blocks) => renderToStaticMarkup(createElement(MarkdownBlocks, { blocks }));

const start = (text: string): Blocks => ({ text, starts: [0], finished: [] });

const corpus: Record<string, string> = {
  paragraphs: 'First paragraph with *emphasis*\nand a second line.\n\nSecond one, `code` and **bold**.\n\nThird.\n',
  headings: '# Title\n\nIntro.\n\n## Section\nText right under.\n\n### Sub\n\nMore text.\n#### Four\n',
  'setext headings': 'Title\n=====\n\nParagraph\n\nSub title\n---\n\nText\n\n---\n\nAfter a rule.\n',
  'tight list': 'Intro:\n\n- one\n- two\n- three\n\nAfter.\n',
  'loose list': 'Intro:\n\n- one\n\n- two\n\n- three\n\nAfter the list.\n\n- another list\n',
  'ordered lists': '1. first\n2. second\n\nText.\n\n3. starts at three\n4. four\n\n1. one\n\n2. two\n\n10. ten\n',
  'nested lists':
    '- a\n  - a1\n  - a2\n\n    continued a2\n- b\n\n  para in b\n\n  ```js\n  const x = 1;\n\n  x++;\n  ```\n- c\n\nEnd.\n',
  'list then other list': '- bullet\n\n1. ordered\n\n* star\n\n+ plus\n\nText\n',
  'indented continuation': 'Para\n    still para\n\n    indented code\n\n    more code\n\nText\n',
  // micromark reads the block after an indented code block as if it interrupted a paragraph: `2. x` is no list there
  'after indented code': '    code\n\n2. not a list here\n\n-\n\n\tcode\n\n1.\n \n\nText\n',
  'block quotes':
    '> quote line\nlazy continuation\n\n> second quote\n>\n> > nested\n\n> - list in quote\n> - b\n\nAfter.\n',
  'fenced code':
    'Code:\n\n```python\ndef f():\n\n    return 1\n\n\n# not a heading\n```\n\nText\n\n~~~\n```\nstill code\n~~~\n\n````md\n```\ninner\n```\n````\n\nEnd\n',
  'unclosed fence': 'Start\n\n```ts\nconst a = 1;\n\n# inside\n\n- inside\n',
  tables: '| a | b |\n|---|:-:|\n| 1 | 2 |\n| 3 | 4 |\n\nText\n\nx | y\n--|--\nz | w\n\n| only |\n| --- |\n',
  'horizontal rules': 'Text\n\n***\n\n- - -\n\n___\nText under\n',
  html: 'Text <span>inline</span>.\n\n<div>\nblock\n\nafter blank\n</div>\n\n<!--\ncomment\n\nstill comment\n-->\n\n<pre>\n\nx\n\n</pre>\n\nEnd\n',
  'reference links':
    'See [the docs][docs] and [other].\n\nMore text.\n\n[docs]: https://example.com/docs\n[other]: /other "Title"\n',
  footnotes: 'A claim[^1] and another[^note].\n\nText.\n\n[^1]: The first.\n\n[^note]: The second,\n    continued.\n',
  'task lists and gfm': '- [x] done\n- [ ] todo\n\n~~struck~~ and www.example.com and https://a.b/c\n',
  'mixed long reply': [
    '# Setting up the server',
    '',
    'Here is how to **build** llama.cpp and run it. First, the requirements:',
    '',
    '1. A C++ compiler',
    '2. CMake',
    '3. A GPU driver',
    '',
    '## Build',
    '',
    'Clone and build:',
    '',
    '```bash',
    'git clone https://github.com/ggml-org/llama.cpp',
    'cd llama.cpp',
    '',
    'cmake -B build -DGGML_CUDA=ON',
    'cmake --build build -j',
    '```',
    '',
    '> **Note**: the build takes a few minutes.',
    'It uses every core.',
    '',
    '### Options',
    '',
    '| Flag | Meaning |',
    '|------|---------|',
    '| `-c` | context |',
    '| `-ngl` | layers on the GPU |',
    '',
    '- **Context**: the number of tokens.',
    '',
    '  It costs memory.',
    '',
    '- **Layers**: how many go to the GPU.',
    '  - all of them: `-ngl 99`',
    '  - some: `-ngl 20`',
    '',
    '---',
    '',
    'Run it:',
    '',
    '    ./build/bin/llama-server -m model.gguf',
    '',
    'Then open the page. That is all.',
    '',
  ].join('\n'),
};

/** Where a stream can stop: before and after each line break, and a sample of offsets inside the lines. */
function cuts(text: string): number[] {
  const at = new Set<number>([0, text.length]);
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      at.add(i);
      at.add(i + 1);
    }
    if (i % 5 === 2) at.add(i);
  }
  return [...at].toSorted((a, b) => a - b);
}

/** A sparser stream (several characters per flush), the same each run. */
function sparse(text: string): number[] {
  const at: number[] = [];
  let seed = text.length;
  for (let i = 0; i < text.length;) {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    i = Math.min(text.length, i + 1 + (seed % 40));
    at.push(i);
  }
  return at;
}

describe('a reply rendered by blocks renders as the whole text', () => {
  for (const [name, doc] of Object.entries(corpus)) {
    test(`${name}, at every cut of the stream`, () => {
      let blocks = start('');
      for (const n of cuts(doc)) {
        const text = doc.slice(0, n);
        blocks = nextBlocks(blocks, text, parsedStarts);
        expect(blocks.text).toBe(text);
        expect(byBlocks(blocks), `${name} at ${n}: ${JSON.stringify(text)}`).toBe(whole(text));
      }
    });

    test(`${name}, streamed several characters at a time`, () => {
      let blocks = start('');
      for (const n of sparse(doc)) {
        const text = doc.slice(0, n);
        blocks = nextBlocks(blocks, text, parsedStarts);
        expect(byBlocks(blocks), `${name} at ${n}`).toBe(whole(text));
      }
    });
  }

  test('random documents, at every cut of the stream', () => {
    // Lines that start, continue or end blocks (in containers too), in blocks of one to four lines
    const lines = [
      '',
      '',
      'para text',
      'more *text*',
      'lazy line',
      'text\\',
      '  continuation',
      '   indented 3',
      ' ',
      '    ',
      '\t',
      '- item',
      '* star',
      '+ plus',
      '1. one',
      '2. two',
      '3) three',
      '10. ten',
      '-',
      '1.',
      '- [ ] task',
      '2)',
      '  - nested',
      '  1. x',
      '    code4',
      '      deep code',
      '\tcode tab',
      '     five',
      '  ~~~~',
      '  <!--',
      '  -->',
      '> quote',
      '> > deep',
      '>',
      '- > quote in list',
      '> - list in quote',
      '> ```',
      '  > quote indented',
      '- ```',
      '- <!--',
      '> <div>',
      '1. ```js',
      '```',
      '~~~',
      '````',
      '```js',
      '  ```',
      '   ```',
      '# head',
      '## h2',
      '===',
      '---',
      '***',
      '- - -',
      '| a | b |',
      '|---|---|',
      'x | y',
      '-|-',
      '<div>',
      '</div>',
      '<!--',
      '-->',
      '<pre>',
      '</pre>',
      '<a href="x">',
      '<script>',
      '</script>',
      '<?x',
      '?>',
    ];
    // mulberry32: the same documents on each run
    let seed = 42;
    const random = (n: number) => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) % n;
    };
    for (let d = 0; d < 150; d++) {
      const blocks = Array.from({ length: 3 + random(10) }, () =>
        Array.from({ length: 1 + random(4) }, () => lines[random(lines.length)]).join('\n'),
      );
      const doc = blocks.join(['\n\n', '\n\n', '\n', '\n\n\n'][random(4)]) + (random(2) ? '\n' : '');
      let state = start('');
      for (let n = 0; n <= doc.length; n++) {
        state = nextBlocks(state, doc.slice(0, n), parsedStarts);
        expect(byBlocks(state), JSON.stringify(doc.slice(0, n))).toBe(whole(doc.slice(0, n)));
      }
    }
  }, 60_000);

  test('a finished reply renders as one block', () => {
    const doc = corpus['mixed long reply']!;
    expect(start(doc).starts).toEqual([0]);
    expect(byBlocks(start(doc))).toBe(whole(doc));
  });
});

describe('the blocks of a growing reply', () => {
  test('earlier blocks keep their start and their text: only the last one changes', () => {
    const doc = corpus['mixed long reply']!;
    let blocks = start('');
    let previous: string[] = [];
    let cut = 0;
    for (const n of cuts(doc)) {
      blocks = nextBlocks(blocks, doc.slice(0, n), parsedStarts);
      // Rendering the blocks parses the last one: its blocks are known for the next text
      byBlocks(blocks);
      const now = pieces(blocks);
      // Every block but the last is unchanged (the same start, the same text): memo skips it, nothing parses it again
      for (let i = 0; i < previous.length - 1; i++) expect(now[i]).toBe(previous[i]);
      if (now.length > 1) cut++;
      previous = now;
    }
    expect(cut).toBeGreaterThan(0);
    expect(blocks.starts.length).toBeGreaterThan(10);
  });

  test('only the end of a long reply is parsed again', () => {
    const paragraph = 'A sentence of a long reply, with **bold** and `code`, that goes on for a while.\n\n';
    const doc = paragraph.repeat(200);
    let blocks = start('');
    let longest = 0;
    for (let n = 0; n <= doc.length; n += 17) {
      blocks = nextBlocks(blocks, doc.slice(0, n), parsedStarts);
      // A flush renders the last piece only (memo skips the others)
      const last = pieces(blocks).at(-1)!;
      byBlocks(start(last));
      longest = Math.max(longest, last.length);
    }
    expect(blocks.starts.length).toBeGreaterThan(190);
    expect(longest).toBeLessThan(3 * paragraph.length);
  });

  test('a text that does not extend the previous one starts again from one block', () => {
    let blocks = start('');
    for (const n of cuts(corpus.paragraphs!)) {
      blocks = nextBlocks(blocks, corpus.paragraphs!.slice(0, n), parsedStarts);
      byBlocks(blocks);
    }
    expect(blocks.starts.length).toBeGreaterThan(1);
    const other = 'A regenerated reply.\n\nDifferent.\n';
    blocks = nextBlocks(blocks, other, parsedStarts);
    expect(blocks.starts).toEqual([0]);
    expect(byBlocks(blocks)).toBe(whole(other));
  });

  test('a reference or footnote definition keeps the reply in one block', () => {
    for (const doc of [corpus['reference links']!, corpus.footnotes!]) {
      let blocks = start('');
      for (const n of cuts(doc)) {
        blocks = nextBlocks(blocks, doc.slice(0, n), parsedStarts);
        byBlocks(blocks);
      }
      expect(blocks.starts).toEqual([0]);
    }
  });
});

describe('the memory of a streamed reply', () => {
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc') as () => void;
  /** The heap that what `make` returns still holds after a garbage collection. */
  const kept = (make: () => unknown) => {
    gc();
    const before = getHeapStatistics().used_heap_size;
    const held = make();
    gc();
    const after = getHeapStatistics().used_heap_size;
    expect(held).toBeDefined();
    return after - before;
  };

  test('a detached slice keeps none of the text it was cut from', () => {
    /** 16 slices of 100 characters, each cut from its own text of 1.1 MiB. */
    const slices = (own: (slice: string) => string) => () =>
      Array.from({ length: 16 }, (_, i) => own(`${String(i)}. A reply’s line\n`.repeat(2 ** 15).slice(0, 100)));
    // A slice alone keeps its text (18 MiB in all): the measure sees the retention it checks
    expect(kept(slices((slice) => slice))).toBeGreaterThan(8 * 2 ** 20);
    expect(kept(slices(detached))).toBeLessThan(2 ** 20);
    expect(detached('a slice of a text, longer than 13 characters')).toBe(
      'a slice of a text, longer than 13 characters',
    );
    expect(detached('')).toBe('');
  });

  test('the finished pieces of a reply keep none of its earlier texts', () => {
    /** A paragraph starts the text and follows each blank line. */
    const paragraphs: StartsOf = (text) => [
      { start: 0, open: false },
      ...[...text.matchAll(/\n\n(?=.)/g)].map((m) => ({ start: m.index + 2, open: false })),
    ];
    const line = (i: number) => `Paragraph ${String(i)} of a reply’s text, as long as a short paragraph is.\n\n`;
    // 600 flushes of one paragraph each: 46 000 characters in the end, 23 MiB if each piece kept the text it was cut from
    const blocks = () => {
      let text = '';
      let state = start('');
      for (let i = 0; i < 600; i++) {
        text += line(i);
        state = nextBlocks(state, text, paragraphs);
      }
      // 0, then a cut before each paragraph but the last (made at the next flush)
      expect(state.starts).toHaveLength(599);
      expect(pieces(state).join('')).toBe(text);
      return state;
    };
    expect(kept(blocks)).toBeLessThan(2 ** 20);
  });
});
