import { shellQuote, shellSplit } from '@llama-webui/shared';

const isFlag = (a: string) => a.length > 1 && a.startsWith('-') && !/^-\d/.test(a);

/** One line per flag and its values, shell-quoted. */
export function formatArgs(args: readonly string[]): string {
  const lines: string[][] = [];
  for (const a of args) {
    if (isFlag(a) || lines.length === 0) lines.push([a]);
    else lines.at(-1)!.push(a);
  }
  return lines.map((l) => shellQuote(l)).join('\n');
}

/** Arguments of the typed text (line breaks separate like spaces). */
export function parseArgs(text: string): string[] | { error: string } {
  return shellSplit(text.replace(/\r?\n/g, ' '));
}

/** The word under the cursor and its bounds; the previous word is used to find a value's flag. */
export function wordAt(text: string, cursor: number): { word: string; start: number; end: number; previous: string } {
  let start = cursor;
  while (start > 0 && !/\s/.test(text[start - 1]!)) start--;
  let end = cursor;
  while (end < text.length && !/\s/.test(text[end]!)) end++;
  let p = start;
  while (p > 0 && /\s/.test(text[p - 1]!)) p--;
  let ps = p;
  while (ps > 0 && !/\s/.test(text[ps - 1]!)) ps--;
  return { word: text.slice(start, end), start, end, previous: text.slice(ps, p) };
}

export function formatEnv(env: Readonly<Record<string, string>>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

/** `KEY=value` per line; empty lines ignored. */
export function parseEnv(text: string): Record<string, string> | { error: string } {
  const env: Record<string, string> = {};
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (!line) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) return { error: `line ${i + 1}: expected KEY=value` };
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return { error: `line ${i + 1}: invalid variable name “${key}”` };
    env[key] = line.slice(eq + 1);
  }
  return env;
}
