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
    path: 'server/contract/',
    line: /homedir|HOME/,
    reason: 'the golden was recorded under Bun, whose homedir() ignored a HOME set at run time',
  },
];

/** Files not swept yet (the N12 tasks empty this list). */
const PENDING: string[] = [
  'CLAUDE.md',
  'README.md',
  'scripts/package.test.ts',
  'site/content/developers/api/overview.mdx',
  'site/content/developers/contributing/conventions.mdx',
  'site/content/developers/contributing/testing.mdx',
  'site/content/developers/contributing/workflow.mdx',
  'site/content/developers/frontend.mdx',
  'site/content/developers/getting-started.mdx',
  'site/content/developers/index.mdx',
  'site/content/developers/server/database.mdx',
  'site/content/developers/shared.mdx',
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
  const uncovered = mentions().filter((m) => !PENDING.includes(m.path) && !ALLOW.some((a) => covers(a, m)));
  expect(uncovered.map((m) => `${m.path}: ${m.text.trim().slice(0, 100)}`)).toEqual([]);
});

test('every allowlist entry still matches a line', () => {
  const all = mentions();
  expect(ALLOW.filter((a) => !all.some((m) => covers(a, m))).map((a) => a.path)).toEqual([]);
  expect(PENDING.filter((p) => !all.some((m) => m.path === p))).toEqual([]);
});
