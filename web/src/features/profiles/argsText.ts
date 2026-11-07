import { shellQuote, shellSplit } from '@llama-webui/shared';

const isFlag = (a: string) => a.length > 1 && a.startsWith('-') && !/^-\d/.test(a);

/** Une ligne par flag et ses valeurs, citées façon shell. */
export function formatArgs(args: string[]): string {
  const lines: string[][] = [];
  for (const a of args) {
    if (isFlag(a) || lines.length === 0) lines.push([a]);
    else lines.at(-1)!.push(a);
  }
  return lines.map((l) => shellQuote(l)).join('\n');
}

/** Arguments du texte saisi (les retours à la ligne séparent comme des espaces). */
export function parseArgs(text: string): string[] | { error: string } {
  return shellSplit(text.replace(/\r?\n/g, ' '));
}

/** Le mot sous le curseur et ses bornes ; le mot précédent sert à retrouver le flag d'une valeur. */
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

export function formatEnv(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

/** `CLÉ=valeur` par ligne ; lignes vides ignorées. */
export function parseEnv(text: string): Record<string, string> | { error: string } {
  const env: Record<string, string> = {};
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (!line) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) return { error: `ligne ${i + 1} : CLÉ=valeur attendu` };
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return { error: `ligne ${i + 1} : nom de variable invalide « ${key} »` };
    env[key] = line.slice(eq + 1);
  }
  return env;
}
