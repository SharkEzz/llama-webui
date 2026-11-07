/** POSIX-shell-style splitting and quoting, without expansion (copied from llama-tui). */

const SAFE = /^[A-Za-z0-9_\-.,:/=@%+]+$/;

export function shellQuote(args: string[]): string {
  return args.map((a) => (SAFE.test(a) ? a : `'${a.replaceAll("'", `'\\''`)}'`)).join(' ');
}

/**
 * The words of a line as a POSIX shell would read them, without expansion: blanks separate; '…' keeps
 * everything; "…" keeps everything but \" and \\; a backslash outside quotes keeps the next character;
 * '' or "" is an empty word. The inverse of `shellQuote`. Returns why when the line cannot be read.
 */
export function shellSplit(text: string): string[] | { error: string } {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === ' ' || c === '\t') {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
      continue;
    }
    inWord = true;
    if (c === '\\') {
      if (i + 1 >= text.length) return { error: 'trailing backslash' };
      word += text[++i];
    } else if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) return { error: 'unclosed quote' };
      word += text.slice(i + 1, end);
      i = end;
    } else if (c === '"') {
      for (i++; ; i++) {
        if (i >= text.length) return { error: 'unclosed quote' };
        const d = text[i]!;
        if (d === '"') break;
        if (d === '\\' && (text[i + 1] === '"' || text[i + 1] === '\\')) word += text[++i];
        else word += d;
      }
    } else word += c;
  }
  if (inWord) words.push(word);
  return words;
}
