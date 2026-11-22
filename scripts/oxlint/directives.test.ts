import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';

const root = join(import.meta.dirname, '..', '..');
const oxlint = join(root, 'node_modules', '.bin', 'oxlint');
const plugin = join(import.meta.dirname, 'directives.ts');

const files: Record<string, string> = {
  'missing.ts': [
    '// oxlint-disable-next-line no-console',
    'console.log(1);',
    '// oxlint-disable-next-line no-console -- the CLI prints its version',
    'console.log(2);',
  ].join('\n'),
  'block.ts': ['/* oxlint-disable no-console */', 'console.log(1);'].join('\n'),
  'eslint.ts': ['/* eslint-disable-next-line no-console -- why */', 'console.log(1);'].join('\n'),
  'empty.ts': ['export const x = 1;', 'console.log(x); // oxlint-disable-line no-console --'].join('\n'),
  'dashes.ts': [
    'console.log(1); /* oxlint-disable-line no-console --- */',
    'console.log(2); // oxlint-disable-line no-console -- -',
    'console.log(3); // oxlint-disable-line no-console -- `log` is the point',
  ].join('\n'),
};

const dir = mkdtempSync(join(tmpdir(), 'lw-directives-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface Diagnostic {
  message: string;
  code: string;
  filename: string;
  labels: Array<{ span: { line: number } }>;
}

const lint = (): Diagnostic[] => {
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), `${text}\n`);
  const config = { jsPlugins: [plugin], rules: { 'directives/require-reason': 'error', 'no-console': 'error' } };
  writeFileSync(join(dir, '.oxlintrc.json'), JSON.stringify(config));
  const run = spawnSync(oxlint, ['-f', 'json', '.'], { cwd: dir, encoding: 'utf8' });
  expect(run.stderr).toBe('');
  const { diagnostics } = JSON.parse(run.stdout) as { diagnostics: Diagnostic[] };
  return diagnostics.filter((d) => d.code === 'directives(require-reason)');
};

let reports: Diagnostic[] = [];
beforeAll(() => {
  reports = lint();
});
const at = (file: string) => reports.filter((d) => d.filename === file).map((d) => d.labels[0]?.span.line);

test('a suppression without a reason is reported on its line', () => {
  expect(at('missing.ts')).toEqual([1]);
});

test('a block suppression without a reason is reported; an eslint- one with a reason is not', () => {
  expect(at('block.ts')).toEqual([1]);
  expect(at('eslint.ts')).toEqual([]);
});

test('dashes with nothing after them are not a reason', () => {
  expect(at('empty.ts')).toEqual([2]);
});

test('more dashes are not a reason either; a reason may start with a backtick', () => {
  expect(at('dashes.ts')).toEqual([1, 2]);
});

test('the message says how to write the reason', () => {
  expect(new Set(reports.map((d) => d.message))).toEqual(new Set(['A suppression states its reason: `-- <reason>`.']));
  expect(reports).toHaveLength(5);
});
