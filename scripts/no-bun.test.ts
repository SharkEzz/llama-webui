// The repository runs on Node.js only: no page, comment, rule or test still talks about Bun, except the history.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const ROOT = join(import.meta.dirname, '..');

/** Where Bun may still be named, and why. `path` is a file or a folder prefix; `line`, when set, the line's text. */
const ALLOW: { path: string; line?: RegExp; reason: string }[] = [
  { path: 'docs/superpowers/', reason: 'plans and specs: the history of the project, Bun era included' },
  { path: '.agents/skills/', reason: 'vendored skills, not ours to edit' },
  { path: 'scripts/no-bun.test.ts', reason: 'this test' },
  {
    path: 'app/server/lib/contract/',
    line: /homedir|HOME/,
    reason: 'the golden was recorded under Bun, whose homedir() ignored a HOME set at run time',
  },
  {
    path: 'site/content/developers/architecture.mdx',
    line: /^Up to v0\.2\.1, llama-webui ran on Bun/,
    reason: 'the one history sentence: where the contract golden comes from',
  },
  {
    path: 'site/content/developers/contributing/testing.mdx',
    line: /the guard `scripts\/no-bun\.test\.ts`/,
    reason: 'the guard documented for contributors, by its file name',
  },
  {
    path: 'CLAUDE.md',
    line: /aucune API ni commande Bun|Don't use `bun:sqlite`|jamais `Bun\.file`/,
    reason: 'the rules name the APIs an agent must not reach for',
  },
];

/** Every text line not ignored by git (tracked or new) that names Bun, as `path:line:text`. */
function mentions(): { path: string; text: string }[] {
  const r = spawnSync('git', ['grep', '--untracked', '-nIiE', String.raw`\bbun\b|bun:|Bun\.`], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (r.status === 1) return []; // no match
  if (r.status !== 0) throw new Error(`git grep exited with ${r.status}: ${r.stderr}`);
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [path = '', , ...text] = l.split(':');
      return { path, text: text.join(':') };
    });
}

const covers = (a: (typeof ALLOW)[number], m: { path: string; text: string }) =>
  (a.path.endsWith('/') ? m.path.startsWith(a.path) : m.path === a.path) && (!a.line || a.line.test(m.text));

test('nothing in the repository mentions Bun outside the allowlist', () => {
  const uncovered = mentions().filter((m) => !ALLOW.some((a) => covers(a, m)));
  expect(uncovered.map((m) => `${m.path}: ${m.text.trim().slice(0, 100)}`)).toEqual([]);
});

test('every allowlist entry still matches a line', () => {
  const all = mentions();
  expect(ALLOW.filter((a) => !all.some((m) => covers(a, m))).map((a) => a.path)).toEqual([]);
});
